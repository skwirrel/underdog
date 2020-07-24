# Introduction
Brute force protection is an interesting problem. You need to keep track of how often any given username has been used over a reasonable amount of time. The lookup should be super-quick as you don't want to slow down the login process. But you need to be able to store a _lot_ of usernames very efficiently because an attacker might deliberately flood the system with a lot of usernames to try and flush your logs. You also need an efficient way to clear out old records after a suitable expiry time (e.g. an hour) without laboriously checking every single record to see if it has expired.  

Here is my take on the problem. This code is written as a standalone service with no external dependencies (other than requiring node.js to be installed) - so, no npm modules required, no database required, not even a web server. This is with a view to enabling users to review the code easily and also to make it easy to install and maintain. It is designed to be simple to integrate - you just open a TCP/IP socket and send it the username. It responds with an answer of either "OK" or "BLOCK".

The code is intended to be very efficient in operation and fairly compact (only 550 lines of code). Running on my i7 laptop I am able to serve 650 requests per second against a database of 1 million usernames. I think most of the limitation here is the speed of my test scripts, not the code - the test scripts were using 40% of my CPU and the code only 11%!

# Main Implementation Principles

## Why Node
Node's event-driven asynchronous architecture means that it can handle thousands of simultaneous connections in one thread without the need for separate server software. This is particularly useful when the code serving these connections need to share resources - in this case each request handler needs to be able to reference a single shared list of usernames encountered. Coding this in something like PHP would have required using shared memory, or a database. A database would introduce considerable connection handling overhead (as well as complicating the setup). Shared memory is tricky to use - especially when it comes to locking and ensuring against race conditions and other subtle bugs.

## Linked List of Records
Each username is stored as a record in a linked list. Each record points forward to the next and back to the previous record. Each time a username is encountered it is added to the front of the list. If it is already in the list it is unlinked from its current position and linked back in to the front of the list. If it has not been encountered before then a new record is pulled of the list of empty records and added to the front of the list. Using a linked list means we don't ever have to move any memory around, we just change the previous and next pointers.

## Map
We use a Javascript native Map object to provide a lookup table of usernames we have already seen. This is more efficient than using keys on a Javascript object. The map contains just a pointer to the record for the username. Using a linked list as described above means that, whilst the records might change their position in the list, their location in memory never changes

## Buffer
We use a Javascript native Buffer object to store the records. This is pre-allocated at the start of the script based on the total capacity defined in the configuration. The data stored in the Buffer is packed in as raw byte representations of the data to avoid the overhead associated with ordinary Javascript variables.

## Expiry
Each time a username is seen, its record is moved to the front of the list. Therefore the back of the list must be the oldest record. When it comes to expiring records we simply work from the back of the list until we find a record which is not due for expiry. We exipre records based on the maxAge in the configuration. This means that we don't need to check whether a record has expired when we encounter it - if it is still in the list it has de-facto not expired. In fact, some records might be a tiny bit older because we only run the expiry process periodically, but as long as the tidyUpInterval is relatively short (e.g. 1 minute) compared to the  maxAge (e.g. 1 hour) then this shouldn't be a big deal i.e. a record could be as old as 61 minutes. As each record is expired we must remember to remove the corresponding entry from the map. This approach keeps both the used record list and the map in check without having to iterate through every record.

## Empty Records
We maintain 2 linked lists held within the same buffer space. One is a list of records in use and the other is a list of empty records. At the start of the code we add all the records in the buffer to the empty list. As each record is used it is unlinked from the empty list and added to the used records list. When a record expires we unlink it from the used record list and add it to the empty record list.  We don't actually bother to overwrite data when a record is moved to the empty list - it will get overwritten when it is reused.

## Running Out of Space
If there are no records left in the empty list when we encounter a new username we simply steel a record off the end of the used record list. We store the new username in that record and reattach it at the front of the used record list. Once again the fact that the used record list is in chronological order helps us here, since we just have to go to the end of the list to find the oldest record. We must remember to remove the entry from the map which corresponds to the record we just kicked out.

## Proxying Requests
Whilst node.js can handle of thousands of simultaneous connections from a single process, Node is single-threaded so all these conections will be using the same processor core. The node process may therefore become CPU-limited whilst a server has spare capacity on other processor cores.

One approach to this would be to fork the process somewhere along the line, but the forked process would end up with a copy of the memory (albeit a very efficient copy-on-write based copy). This means that the database of which names have been seen or not would begin to diverge as soon as the process forked which is not what we want.

The approach we use here is to simply run a separate Node process on each CPU core and divide the space of all possible usernames up between all the servers. As long as we make sure that the same username will always end up at the same process then this should work fine. Each process listens on a different TCP/IP port. We use the last character of the username (actually usually the hash of the username) to determine which server it should go to. Ideally the client will do work out which process to send the username to but, to make the client implementation as simple as possible we also handle miss-addressed requests at the server end. Each process checks each incoming request to make sure it really should be handling it. If it has arrived at the wrong process then the recieving process will re-address it to the correct process. This is handled by the recieving process proxying it on to the correct process and then passing the response back through to the caller. So the caller doesn't need to worry - you can send all requests to one port, or (better) send the requests to a random port without worrying about working out which process is the right one.

# Installation
Run `install.sh` as root. Underdog doesn't (yet) have the necessary gubbins to run as a service. Instead it is designed to be run from cron. The install script puts a file called `underdog` in `/etc/cron.d/`. This triggers the underdog script every minute. The underdog script reads its configuration from `/etc/underdog.conf` and looks at which ports it should be running on. It tries to bind to each port in turn until it runs out. If it finds an available port it will start listening on it and stop trying other ports.

This approach means that it takes a few minutes for all the instances to come up because cron will only start one a minute. Once all the ports are used up then the underdog script will run once a minute, but do nothing, unless any of the scripts has stopped working at which point the next one to run will take up the port which has been vacated.

This approach is designed to keep everything really simple, but still reasonably robust.

# API Definition
## Request
The request consists of a single 32 character hex encoded string (i.e. 16 bytes of raw data) or a command (see below) followed by an optional newline (\n). The 32 character string is intended to be some sort of hash of the username which the user is attempting to log in with.

The request is made by opening a TCP/IP connection to the IP where the service is running on a pre-agreed port range. The port chosen should be based on the last byte of the hash being submitted by taking the modulus of this value and the number of ports in the range. However, each server will proxy the request on if it lands at the wrong server so an alternative approach is simply to pick a port at random from the range, or even just fire all the requests at one port.

## Response

The response to a has will be a single line consisting of a result followed by a new line (\n). The connection will then be closed by the server. Responses are:

`OK:<count>` - The rate limit has not been exceeded. The count tells you how many time this hash provided has been encountered. There is no fixed timescale since the window is extended each time the username is encountered.

`BLOCK:<unixtime>` - The rate limit has been exceeded, this username will not be allowed to log in until the time specified (it is up to the caller whether this time is revealed to the end user or not).

`ERROR:<error message>` - some sort of error occurred - it is up to you whether you decide to allow or block the login attempt.

## Commands
As mentioned above you can pass a command instead of a hash to the server. The following commands are supported:

### STOP
This command will cause all underdog instances to stop. This works by the instance that receives the command relaying it on to the next server. This wraps so that the last server will relay the command back to the first.

If one of the servers in the middle of the range has fallen over then servers beyond this one will not get the message and you will need to send them the message directly.

### STATS
This command causes the server to dump some statistics about its operation back to the caller.
e.g.
```
$ echo 'STATS' | nc 127.0.0.1 16000
logSize=133735
freeSlots=914841
uptime=6671
errorRate=0
proxyRate=506633
queryRate=290955
connectionRate=797591
numClientsNow=1
```
The "...Rate" figures are all expressed as "per hour" figures.
The `logSize` and `freeSlots` figures are reported live. All the other figures are computed periodically as defined by statsUpdateInterval in the configuration file.

# Configuration
The server will look for a configuration file called `/etc/underdog.conf`. An alternative location can be provided when invoking the `underdog.js` script e.g. 
```
underdog.js /path/to/my/underdog.conf
```
A description of each configuration parameter can be found in the example `underdog.conf` file supplied in this repository.

# Security
To keep the server and API as streamlined and simple as possible there is no authentication built into the protocol. It is envisaged that firewalling will be used to secure access to the underdog server. This might be done by just running the server on the same server as the application it is protecting and having it listen only on 127.0.0.1, or running it on some internal server which does not have a publicly accessible interface. Alternatively the port ranges used can be restricted on the firewall (e.g. by setting a limited range of source IP's in an AWS security group)
