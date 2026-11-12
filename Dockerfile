# Web app + own BRouter server in one container (used for the Render deployment, see render.yaml).
FROM caddy:2-alpine AS caddy

FROM eclipse-temurin:17-jre

ARG BROUTER_VERSION=1.7.10
# Routing data tiles (5x5 degrees) from https://brouter.de/brouter/segments4/, space separated.
ARG TILES="E0_N50"

WORKDIR /app/brouter
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /tmp/brouter.zip "https://github.com/abrensch/brouter/releases/download/v${BROUTER_VERSION}/brouter-${BROUTER_VERSION}.zip" \
 && unzip -q /tmp/brouter.zip -d /tmp \
 && mv "/tmp/brouter-${BROUTER_VERSION}/brouter-${BROUTER_VERSION}-all.jar" brouter.jar \
 && mv "/tmp/brouter-${BROUTER_VERSION}/profiles2" profiles2 \
 && mkdir -p segments4 customprofiles \
 && for t in $TILES; do curl -fsSL -o "segments4/$t.rd5" "https://brouter.de/brouter/segments4/$t.rd5"; done \
 && rm -rf /tmp/brouter*

# Place names for instant search in the browser (see deploy/build-places.sh).
ARG PLACES_COUNTRIES="BE NL LU FR"
COPY deploy/build-places.sh /tmp/build-places.sh
RUN mkdir -p /app/data && sh /tmp/build-places.sh /app/data/places.json $PLACES_COUNTRIES && rm /tmp/build-places.sh

COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=755 deploy/entrypoint.sh /entrypoint.sh
COPY index.html app.js style.css /srv/www/

# Sized for a 512 MB instance (Render free/starter).
ENV PORT=10000 \
    JAVA_OPTS="-Xmx256M -Xms64M -Xss512k -XX:MaxMetaspaceSize=64M -XX:+UseSerialGC"
EXPOSE 10000
CMD ["/entrypoint.sh"]
