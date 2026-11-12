#!/bin/sh
# Builds places.json for instant place search in the browser: populated places from GeoNames
# (https://www.geonames.org, CC BY 4.0) as [name, lat, lon, region, country, population, "alt|names"].
# Usage: build-places.sh <output> <country codes...>
set -e
out=$1; shift
tmp=$(mktemp -d)
cd "$tmp"
curl -fsSLO https://download.geonames.org/export/dump/admin1CodesASCII.txt
curl -fsSLO https://download.geonames.org/export/dump/admin2Codes.txt
for c in "$@"; do
  curl -fsSLO "https://download.geonames.org/export/dump/$c.zip"
  unzip -oq "$c.zip" "$c.txt"
done

awk -F'\t' '
function esc(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); return s }
BEGIN {
  # GeoNames uses English names for some big places and regions; show the local (Dutch) ones.
  local["Antwerp"] = "Antwerpen"; local["Brussels"] = "Brussel"; local["Ostend"] = "Oostende"
  local["The Hague"] = "Den Haag"; local["Bruxelles-Capitale"] = "Brussel"
  local["North Brabant"] = "Noord-Brabant"; local["North Holland"] = "Noord-Holland"; local["South Holland"] = "Zuid-Holland"
}
FILENAME == "admin1CodesASCII.txt" { a1[$1] = $2; next }
FILENAME == "admin2Codes.txt" { a2[$1] = $2; next }
# Populated places, without historical/abandoned/destroyed ones.
$7 != "P" || $8 ~ /^PPL[HQW]$/ { next }
{
  cc = $9; pop = $15 + 0
  # France has very many tiny hamlets; keep its search list compact (only the north, near the
  # default routing tile; Nominatim still finds everything else).
  if (cc == "FR" && (pop < 500 || $5 < 48)) next
  # Belgian provinces are admin2, elsewhere the province/region is admin1.
  region = cc == "BE" ? a2[cc "." $11 "." $12] : a1[cc "." $11]
  sub(/^(Provincie|Province de|Province du|Province de la|Province of) /, "", region)
  if (region in local) region = local[region]
  name = ($2 in local) ? local[$2] : $2
  # Other-language names (e.g. Luik for Liège) for the larger places only.
  alt = name != $2 ? $2 : ""
  if (pop >= 50000) {
    n = split($4, names, ",")
    delete seen; seen[name] = 1; seen[$2] = 1
    for (i = 1; i <= n; i++) {
      a = names[i]
      if (a !~ /^[A-Za-z][A-Za-z '\''.-]*$/ || a !~ /[a-z]/ || length(a) < 3 || length(a) > 40 || a in seen) continue
      seen[a] = 1; alt = alt (alt == "" ? "" : "|") a
    }
  }
  printf "%s[\"%s\",%.4f,%.4f,\"%s\",\"%s\",%d,\"%s\"]", (count++ ? ",\n" : "["), esc(name), $5, $6, esc(region), cc, pop, esc(alt)
}
END { print "]" }
' admin1CodesASCII.txt admin2Codes.txt $(for c in "$@"; do echo "$c.txt"; done) > "$out"

cd / && rm -rf "$tmp"
echo "places.json: $(grep -c '^' "$out") places, $(wc -c < "$out") bytes"
