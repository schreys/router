#!/bin/sh
# Starts a local BRouter server on http://localhost:17777 (same API as brouter.de).
# Extra map data: download .rd5 tiles from https://brouter.de/brouter/segments4/ into segments4/.
cd "$(dirname "$0")" || exit 1
mkdir -p customprofiles
exec java -Xmx1024M -Xms128M -Xmn8M -DmaxRunningTime=300 \
  -cp brouter-1.7.10/brouter-1.7.10-all.jar \
  btools.server.RouteServer segments4 brouter-1.7.10/profiles2 customprofiles 17777 4 localhost
