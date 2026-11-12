# Fietsplanner – komoot clone

A small static web app for viewing and planning bike routes on OpenCycleMap.

## Features

- **Map layers**: OpenCycleMap, Outdoors and Landscape (Thunderforest, need an API key), CyclOSM, OpenStreetMap, plus an overlay with cycle node networks/routes (Waymarked Trails).
- **Route planning**: click "Route tekenen" and click points on the map. The route follows roads via [BRouter](https://brouter.de) (profiles: touring bike, road bike, safe, MTB, shortest, hiking) or straight lines.
- **Route editing**: drag points (the route is re-calculated live while dragging), click on the line to insert a point, right-click or double-click a point to delete it, undo (Ctrl/Cmd+Z), reverse.
- **GPX**: load multiple GPX files (button or drag-and-drop), show/hide them, and convert one to an editable route with "Bewerk als route". Export the current route as GPX.
- **Stats & elevation profile**: distance, estimated time, ascent/descent. Hovering over the profile shows the position on the map.
- The current route and the API key are stored in the browser (localStorage).

## Running it

```bash
cd komoot-clone
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Use a local server rather than `file://`, because some tile servers require a Referer header.

## Local routing (optional)

By default routes are calculated by the public server at brouter.de, which rate-limits heavy use (HTTP 403 "Please, retry later!"). For fast, unlimited routing, run BRouter locally (needs Java 11+):

```bash
brouter/start.sh   # serves http://localhost:17777
```

The app detects the local server automatically (status shown under "Rechte lijnen"); it falls back to brouter.de when the server isn't running or the route is outside the downloaded area. Only the routing is local; the map tiles are still loaded online.

Setup (already done in this folder, ignored by git): unzip the [BRouter release](https://github.com/abrensch/brouter/releases) into `brouter/` and put routing data tiles (`.rd5`, 5°×5° each, e.g. `E0_N50.rd5` for most of Belgium) from <https://brouter.de/brouter/segments4/> into `brouter/segments4/`. Re-download the tiles occasionally to get recent OpenStreetMap changes.

## Deployment (Render)

The [Dockerfile](Dockerfile) builds one container with the web app and its own BRouter server: [Caddy](https://caddyserver.com) serves the static files and proxies `/brouter` to BRouter, which the app uses automatically when it isn't running on localhost. BRouter and the routing tiles (`TILES` build arg, default `E0_N50`) are downloaded during the build.

On Render: **New → Blueprint**, select this repository; [render.yaml](render.yaml) creates a Docker web service. Every push to `main` redeploys. To refresh the routing data, use **Manual Deploy → Clear build cache & deploy**.

Test the image locally:

```bash
docker build -t router . && docker run --rm -p 8080:10000 router   # http://localhost:8080
```

On the free plan the service sleeps after 15 minutes without traffic (first visit then takes about a minute) and has little CPU, so long routes are slow; the Starter plan avoids both.

## OpenCycleMap API key

OpenCycleMap is served by Thunderforest and needs a (free) API key:
create one at <https://manage.thunderforest.com/> and paste it into the sidebar. Without a key, CyclOSM is used.
