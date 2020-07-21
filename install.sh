#!/bin/bash

# Change directory to directory of this script
cd "$(dirname "$0")"

if [ `whoami` != 'root' ]; then
    echo "You must be root to run this script."
    exit
fi

echo "Checking if Node is installed..."
if which node > /dev/null; then
    echo "Yep... node is installed!"
else
    echo "Nope..."
    echo "Please install Node.js and then rerun this script"
fi

if (
    echo Copying main program into place in /usr/bin/underdog.js &&
    install -o root -g root -m755 underdog.js /usr/sbin/underdog.js &&
    echo Copying config into place in /etc/underdog.conf &&
    install -o root -g root -m644 underdog.conf /etc/underdog.conf
    echo Copying cron configuration into /etc/cron.d
    install -o root -g root -m644 underdog.cron /etc/cron.d/underdog
); then 
    echo "ALL DONE!"
else 
    echo "Problem encountered during installation"
    echo "Any files that were installed have been left in place - you will have to remove these by hand if that is what you want to do"
fi
