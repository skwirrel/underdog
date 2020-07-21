#!/usr/bin/env nodejs

/*
============================================================================================================
SYNCRHONOUSLY READ THE CONFIG FILE
============================================================================================================
*/

const fs = require('fs');
const os = require('os');

var configFile = '/etc/underdog.conf';
var arguments = process.argv.slice(2);
if (typeof arguments[0] != 'undefined') {
	configFile = arguments[0];
}

if (!fs.existsSync(configFile)) {
	console.error('Couldn\'t find configuration file: '+configFile);
	process.exit(1);
}

const config = {
	timeChunk 				: 3600*2,
	numRecords				: 1024,
	maxCount				: 100,
	maxAge					: 3600, // Seconds
	tidyUpInterval  		: 60, // Seconds
	statsUpdateInterval 	: 60,
	debug					: false,
	basePort				: 8000,
	listenIp				: '127.0.0.1',
	proxyIp					: ''
};

config.instances = os.cpus().length;
	
const wholeLineCommentRegexp = /^\s*(#|\/\/|$)/;
const endOfLineCommentRegexp = /\s*(#|\/\/).*?$/;

var lines = fs.readFileSync(configFile, 'utf-8').split('\n').forEach( function(line){
	if (line.match(wholeLineCommentRegexp)) return;
	let key, value;
	[key, value] = line.split('=');
	key = key.trim();
	value = value.trim();
	value = value.replace(endOfLineCommentRegexp,'');

	if (typeof(config[key]) == 'undefined') return;
	
	if (value==='false') value=false;
	else if (value==='true') value=true;
	else if (typeof(config[key]) == 'number') value = parseInt(value);
	config[key]= value;
});

if (config.debug) console.log('Loaded the following configuration:', config );

/*
============================================================================================================
CORE HASH TRACKING CODE
============================================================================================================
*/

var checkHash, getStats;

(function() {

	const timeChunk = config.timeChunk;
	const numRecords = config.numRecords;
	const maxCount = config.maxCount;
	const maxAge = config.maxAge; // Seconds
	const tidyUpInterval = config.tidyUpInterval; // Seconds
	const debug = config.debug;
	
	const timeChunkSize = bytesRequired( timeChunk );
	const ptrSize = bytesRequired( numRecords );
	const hashSize = 16;
	const countSize = bytesRequired( maxCount );

	/*
	Each record consist of...
	 - The hash
	 - The time this hash was last seen
	 - The number of times this hash has been seen
	 - The pointer to the next record in the list
	 - The pointer to the previous record in the list
	*/
	const recordSize = hashSize + timeChunkSize + countSize + ptrSize + ptrSize;

	const hashOffset = 0;
	const lastSeenTimeOffset = hashSize;
	const countOffset = lastSeenTimeOffset + timeChunkSize;
	const nextPtrOffset = countOffset + countSize;
	const prevPtrOffset = nextPtrOffset + ptrSize;

	if (debug) console.log('Record size is:',recordSize);
	if (debug) console.log('Buffer size is:',numRecords * recordSize);
	// I have no idea why the +1 is required here - seems like node is out by one
	const recordBuffer = Buffer.alloc( numRecords * recordSize +1 );

	function bytesRequired(y) {
	  return Math.ceil( Math.log(y) / Math.log(2) / 8 );
	}

	// ---------------------------------------------------------
	// Define the RecordList object
	// ---------------------------------------------------------
		
	const RecordList = function(){
		this.headPtr=0;
		this.tailPtr=0;
		this.size=0;
	}

	RecordList.prototype.detachRecord = function( recordPtr ) {
		let offset = recordPtr * recordSize;
		
		let count = recordBuffer.readUIntBE( offset + countOffset, countSize );
		let nextPtr = recordBuffer.readUIntBE( offset + nextPtrOffset, ptrSize );
		let prevPtr = recordBuffer.readUIntBE( offset + prevPtrOffset, ptrSize );
		
		let nextRecordOffset = nextPtr * recordSize;
		let prevRecordOffset = prevPtr * recordSize;

		// make the previous record point forward to the next record
		// unless this is the tail of the list
		if ( recordPtr != this.tailPtr ) recordBuffer.writeUIntBE( nextPtr, prevRecordOffset + nextPtrOffset, ptrSize );
		// If this is the tail of the list make the next record the new tail
		else this.tailPtr = nextPtr;

		// make the next record point back to the previous record
		// unless this is the head of the list
		if ( recordPtr != this.headPtr )recordBuffer.writeUIntBE( prevPtr, nextRecordOffset + prevPtrOffset, ptrSize );
		// If this is the head of the list make the previous record the new head
		else this.headPtr = prevPtr;
		
		this.size--;
		
		return count;
	}

	RecordList.prototype.push = function( recordPtr ) {
		/*
			console.log('Pushing '+recordPtr);
			console.log('Current head is at '+this.headPtr);
			console.log('Current size is '+this.size);
		*/
		if (this.size>0) {
			let headOffset = this.headPtr * recordSize;
			let recordOffset = recordPtr * recordSize;
			// Set the nextPtr on the record which is currently at the head to point to the new record
			// ... but only if there actually is an existing head
			recordBuffer.writeUIntBE( recordPtr, headOffset + nextPtrOffset, ptrSize );
		
			// Set the prevPtr on the new record to point back to the what used to be the head
			// ... but only if there actually is an existing head
			// console.log('Writing: ',this.headPtr, recordOffset + prevPtrOffset);
			recordBuffer.writeUIntBE( this.headPtr, recordOffset + prevPtrOffset, ptrSize );
		} else {
			// If this is the first record then it is both the head and the tail
			this.tailPtr = recordPtr;
		}

		this.size++;
		
		// Make the new record the head
		this.headPtr = recordPtr;
	}

	RecordList.prototype.chop = function( ) {

		let tailPtr = this.tailPtr;
		let tailOffset = tailPtr * recordSize;
		
		// Make the next record the new tail
		// ... but only if this isn't the list record in the list
		if (this.size>1) {
			this.tailPtr = recordBuffer.readUIntBE( tailOffset + nextPtrOffset, ptrSize );
		}

		this.size--;

		return tailPtr;
	}

	// ---------------------------------------------------------
	// End of RecordList Object
	// ---------------------------------------------------------
	
	
	// Create two record lists: one for empty records to be reused and the other for hashes we have seen
	const emptyRecords = new RecordList();
	const seenHashes = new RecordList();
	const seenHashesIndex = new Map();

	// Add all the record to the Empty Records Stack
	for( var ptr=0; ptr<numRecords; ptr++ ) {
		emptyRecords.push( ptr );
	}

	function removeFromIndex( recordPtr ) {
		let recordOffset = recordPtr * recordSize;
		let hash = recordBuffer.toString('latin1', recordOffset + hashOffset, recordOffset+hashSize);
		seenHashesIndex.delete( hash );
		if (debug) console.log('Removing index entry for '+(Buffer.from(hash, 'latin1').toString('hex')));
	}

	function getNow() {
		return Math.round(new Date().getTime()/1000) % timeChunk;
	}
	
	// ---------------------------------------------------------
	// Main function
	// ---------------------------------------------------------

	// This is the main checkHash function which gets exported
	checkHash = function( hash ) {

		// convert the hash to a raw byte string (via a transient Buffer)
		hash = Buffer.from(hash, 'hex').toString('latin1');
		
		let result;
		let count = 0;
		
		// see if we have encountered this hash before
		let recordPtr = seenHashesIndex.get(hash);
		let recordOffset;

		if (typeof(recordPtr) != 'undefined') {	
		
			// YES! we have seen it before
			
			// Retrieve the record and at the same time detach it from the list
			count = seenHashes.detachRecord( recordPtr );
			
			recordOffset = recordPtr * recordSize;

		} else {
		
			// This is a new hash we haven't seen before
			
			// See if we have any empty slots free
			if ( emptyRecords.size == 0 ) {
				// Oh no... we have run out of space
				// Just have to delete the last entry whether it expired or not
				recordPtr = seenHashes.chop();
				// Remove the entry we are about to overwrite from the index
				removeFromIndex( recordPtr );
			} else {
				// Grab an empty slot from the list of empty records
				recordPtr = emptyRecords.chop();
			}
		
			recordOffset = recordPtr * recordSize;

			// Create the new record
			recordBuffer.write(hash, recordOffset + hashOffset, hashSize, 'latin1');

			// update the map to include the new hash
			seenHashesIndex.set(hash,recordPtr);
			if (debug) console.log('Adding index entry for '+(Buffer.from(hash, 'latin1').toString('hex')));
		}

		if ( count >= maxCount ) result = 'BLOCK:'+(Math.round(new Date().getTime()/1000))+config.maxAge+config.tidyUpInterval;
		else {
			result = 'OK:'+(count+1);
			recordBuffer.writeUIntBE( count+1, recordOffset + countOffset, countSize );
		}
		
		// set the last seen time for the record to be now
		recordBuffer.writeUIntBE( getNow(), recordOffset + lastSeenTimeOffset, timeChunkSize );

		// Add the record to the head of the seen hashes list
		seenHashes.push( recordPtr );
		
		// Dump the entire buffer - only for detailed debug
		// if (debug) console.log(recordBuffer.toString('hex').match(new RegExp('.{'+(recordSize * 2)+'}','g')).join(','));
		
		return result;
	}

	// ---------------------------------------------------------
	// GetStats function
	// ---------------------------------------------------------

	getStats = function() {
		return {
			logSize 	: seenHashes.size,
			freeSlots	: emptyRecords.size,
		}
	}

	// ---------------------------------------------------------
	// TidyUp function
	// ---------------------------------------------------------

	function tidyTail() {
		// if the seenHashes list is empty there is nothing to do
		while( seenHashes.size > 0 ) {
		
			let lastSeenTime = recordBuffer.readUIntBE( seenHashes.tailPtr * recordSize + lastSeenTimeOffset, timeChunkSize );
			let age = getNow() - lastSeenTime;
			
			if (age<0) age += timeChunk;
		
			if (age>maxAge) {
				// this record has expired - remove it from the seenHashes list and add it to the emptyRecords list
				let recordPtr = seenHashes.chop();
				// Remove the expired entry from the index
				removeFromIndex( recordPtr );
				emptyRecords.push( recordPtr );
				if (debug) {
					console.log('Expired record removed. Records remaining:',seenHashes.size);
					console.log('Empty records:',emptyRecords.size);
					console.log('Index size is now:',seenHashesIndex .size);
					
				}
			}
			else break;
		}
	}
	
	setInterval( tidyTail, tidyUpInterval );

})();


/*
============================================================================================================
SERVER CODE
============================================================================================================
*/

const maxCommandLength = 32;

var net = require('net');

var numClients = 0;
var numConnections = 0;
var numErrors = 0;
var numProxied = 0;
var numQueries = 0;
var connectionRate = 0;
var errorRate = 0;
var proxyRate = 0;
var queryRate = 0;
var listenPort = 0;
var startedAt = new Date().getTime();
var shuttingDown = false;

const commandRegexp = /^([0-9a-hA-H]{32}|STOP|STATS)$/i;

if ( !config.proxyIp.length ) config.proxyIp = config.listenIp;


function updateStats() {
	if (config.debug) console.log('Updating stats');
	connectionRate = ( connectionRate + (numConnections/config.statsUpdateInterval) ) / 2;
	errorRate = ( errorRate + (numErrors/config.statsUpdateInterval) ) / 2;
	proxyRate = ( proxyRate + (numProxied/config.statsUpdateInterval) ) / 2;
	queryRate = ( queryRate + (numQueries/config.statsUpdateInterval) ) / 2;
	numConnections = 0;
	numErrors = 0;
	numProxied = 0;
	numQueries = 0;
}

setInterval( updateStats, config.statsUpdateInterval*1000 );

function writeAndClose( socket, message ) {
	if (message.substr(0,5)==='ERROR') numErrors++;
	if (config.debug) console.log('About to write '+message);
	if (config.debug) console.log('Closing client connection');
	socket.write(message);
	socket.end();
	if (shuttingDown) setTimeout(function(){
		if (config.debug) console.log('SHUTTING DOWN');
		process.exit(0);
	},1000);

}

function proxyOrProcess( socket, hash ) {
	let destPort;

	var closed = false;
	
	if (hash=='stats') {
		let stats = getStats();
		stats.uptime = (new Date().getTime() - startedAt)/1000;
		stats.errorRate = errorRate * 3600;
		stats.proxyRate = proxyRate * 3600;
		stats.queryRate = queryRate * 3600;
		stats.connectionRate = connectionRate * 3600;
		stats.numClientsNow = numClients;
		let textStats = '';
		for (var stat in stats) {
			textStats += stat+'='+Math.round(stats[stat])+'\n';
		}
		writeAndClose( socket, textStats );
		return;
	}
	
	if (hash=='stop') {
		// If we are already in the process of shutting down then ignore this
		// This is probably the stop command going full circle
		if (shuttingDown) return;

		shuttingDown = true;	
		closed = true;
		writeAndClose( socket, 'SHUTTING DOWN\n' );

		// Pass on the stop command
		if ( config.instances==1 ) return;
		destPort = config.basePort + (listenPort-config.basePort+1) % config.instances;
	} else {
		destPort = config.basePort + parseInt(hash.substring(hash.length-3),16) % config.instances;
	}
	
	if ( destPort == listenPort ) {
		numQueries++;
		writeAndClose( socket, checkHash(hash)+'\n' );
	} else {
		numProxied++;
		if (config.debug) console.log('Proxying to port '+destPort+' on '+config.proxyIp);

		var client = new net.Socket();
		var buffer = '';
		client.connect(destPort, config.proxyIp, function() {
			if (config.debug) console.log('Proxy connected');
			client.write(hash+'\n');
		});

		client.on('error', function() {
			if (!closed) writeAndClose(socket, 'ERROR:Problem proxying on request\n');
			closed = true;
		});
		
		client.on('data', function(data) {
			buffer+=data;
			client.destroy(); // kill client after server's response
		});

		client.on('close', function() {
			if (!closed) writeAndClose(socket, buffer);
			if (config.debug) console.log('Proxy connection closed');
			this.destroy();
		});
	}
}

var server = net.createServer(function(socket) {
	
	numConnections++;
	numClients++;
	var commandBuffer='';
	var recordedClosure=false;;
	
	if (config.debug) console.log(numClients+' clients connected');
	socket.setEncoding('latin1');

	socket.on('error', function(err){
		if (config.debug) console.log('Client network error :'+err.toString());
		if (!recordedClosure) numClients--;
		recordedClosure=true;
		this.destroy();
	});
	
	socket.on('end', function(){
		if (!recordedClosure) numClients--;
		recordedClosure=true;
		if (config.debug) console.log('Client connection closed');
	});
  
	socket.on('data', function(buffer) {
		commandBuffer += buffer;
		crPos = commandBuffer.indexOf('\n');
		lfPos = commandBuffer.indexOf('\r');
		// Use the linefeed if this is before the carriage return
		if (lfPos>0 && lfPos<crPos) crPos = lfPos;
		if (crPos>0) commandBuffer = commandBuffer.substring(0,crPos);
		if (crPos>0 || commandBuffer.length>=maxCommandLength) {
			if ( commandBuffer.length > maxCommandLength ) return writeAndClose( socket, 'ERROR:Command too long\n');
			if (config.debug) console.log('> '+commandBuffer);
			let matches;
			if ( !(matches = commandBuffer.match(commandRegexp)) ) return writeAndClose( socket, 'ERROR:Invalid input - expected command or 32 character hex string\n');
			
			proxyOrProcess( socket, matches[0].toLowerCase() );
		}
	});
});


var portOffset=-1;

portNumber = config.basePort;

server.on('error',function(e){
	if (e.code=='EADDRINUSE') {
		if (config.debug) console.log('Port already in use - trying next one');
		setImmediate(tryNextPort);
	} else {
		if (config.debug) console.error('Unexpected networking error: '+e.toString());
		process.exit(1);
	}
});

server.on('listening',function(p){
	let address = this.address();
	if (config.debug) console.log('Server bound to port ',address.port,' on IP: ',address.address);
	listenPort = address.port;
});

function tryNextPort() {
	portOffset++;

	var portNumber = config.basePort + portOffset;

	if (portOffset==config.instances) {
		if (config.debug) console.log('All ports already listening - nothing to do here');
		process.exit(1);
		return;
	}

	if (config.debug) console.log('Trying to listen on ',portNumber);
	
	
	server.listen({
		port: portNumber,
		host: config.listenIp
	});
}

tryNextPort();
