# Fietsplanner – komoot clone

A small static web app for viewing and planning bike routes on OpenCycleMap.

## Features

- **Map layers**: OpenCycleMap, Outdoors and Landscape (Thunderforest, need an API key), CyclOSM, OpenStreetMap, plus an overlay with cycle node networks/routes (Waymarked Trails).
- **Place search** on the map (search-as-you-type via [Photon](https://photon.komoot.io), falling back to [Nominatim](https://nominatim.openstreetmap.org) when Photon is unavailable); a found place can be added to the route.
- **Route planning**: click "Route tekenen" and click points on the map. The route follows roads via [BRouter](https://brouter.de) (profiles: touring bike, road bike, safe, MTB, shortest, hiking) or straight lines.
- **Route editing**: drag points (the route is re-calculated live while dragging), drag the line (or click it) to insert a point there, right-click or double-click a point to delete it, undo (Ctrl/Cmd+Z), reverse.
- **GPX**: load multiple GPX files (button or drag-and-drop), show/hide them, and convert one to an editable route with "Bewerk als route". Export the current route as GPX.
- **Stats & elevation profile**: distance, estimated time, ascent/descent. Hovering over the profile shows the position on the map.
- The current route and the API key are stored in the browser (localStorage).

## Running it

```bash
cd komoot-clone
docker compose up --build
```

Then open <http://localhost:8080>. This runs the same container as in production (see [Dockerfile](Dockerfile)): [Caddy](https://caddyserver.com) serves the web app and proxies `/brouter` to an own [BRouter](https://github.com/abrensch/brouter) server, so routing is fast and not rate-limited. The project folder is mounted into the container, so changes to `index.html`, `app.js` and `style.css` only need a browser reload; rebuild (`--build`) after changing the Dockerfile or `deploy/`.

The app checks for its own BRouter at `/brouter` (status shown under "Rechte lijnen") and falls back to the public server at brouter.de when it isn't available, e.g. with a plain static server like `python3 -m http.server`, or when a route is outside the downloaded area. brouter.de rate-limits heavy use (HTTP 403 "Please, retry later!"). Only the routing runs in the container; the map tiles are loaded online.

### Routing data

BRouter and its routing data tiles (`.rd5`, 5°×5° each, from <https://brouter.de/brouter/segments4/>) are downloaded during the Docker build. The `TILES` build arg (default `E0_N50`, covering most of Belgium, the western Netherlands and northern France) selects the tiles, e.g. `TILES="E0_N50 E5_N50"`; more tiles need more memory. Turn on the map overlay **BRouter-segmenten** (layers button, top right) to see the tile grid; tiles available on the own server are green. The tiles are refreshed weekly upstream; rebuild without cache (`docker compose build --no-cache`) to pick up recent OpenStreetMap changes.

## Deployment (Render)

On Render: **New → Blueprint**, select this repository; [render.yaml](render.yaml) creates a Docker web service from the same Dockerfile. Every push to `main` redeploys. To refresh the routing data, use **Manual Deploy → Clear build cache & deploy**.

On the free plan the service sleeps after 15 minutes without traffic (first visit then takes about a minute) and has little CPU, so long routes are slow; the Starter plan avoids both.

## OpenCycleMap API key

OpenCycleMap is served by Thunderforest and needs a (free) API key:
create one at <https://manage.thunderforest.com/> and paste it into the sidebar. Without a key, CyclOSM is used.
