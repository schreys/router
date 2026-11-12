#!/bin/sh
# Runs BRouter on localhost:17777 (restarted if it ever exits) and Caddy in the foreground on $PORT.
cd /app/brouter || exit 1
(
  while true; do
    java $JAVA_OPTS -DmaxRunningTime=60 -cp brouter.jar \
      btools.server.RouteServer segments4 profiles2 customprofiles 17777 4 localhost
    echo "BRouter exited ($?), restarting in 2s" >&2
    sleep 2
  done
) &
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
