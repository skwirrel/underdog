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

`ERROR` - some sort of error occurred - it is up to you whether you decide to allow or block the login attempt.

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
