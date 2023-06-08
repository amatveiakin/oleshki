const fs = require("fs");

const COORD_DIST_THRESHOLD_KM = 1;

// https://stackoverflow.com/a/18883819/3092679
function distance(coord1, coord2) {
  let [lat1, lon1] = coord1;
  let [lat2, lon2] = coord2;
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  lat1 = toRad(lat1);
  lat2 = toRad(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const d = R * c;
  return d;
}

// Converts numeric degrees to radians
function toRad(Value) {
  return (Value * Math.PI) / 180;
}

function serializeCoords(coords) {
  if (!coords) {
    return undefined;
  }
  const [lat, long] = coords;
  return `${lat}, ${long}`;
}

function parseCoords(coords) {
  if (!coords) {
    return undefined;
  }
  const segments = coords.split(",").map((s) => s.trim());
  if (segments.length !== 2) {
    return undefined;
  }
  const [lat, long] = segments;
  return [parseFloat(lat), parseFloat(long)];
}

// function extractBestAddress(addressLine) {
//   if (!addressLine) {
//     return undefined;
//   }
//   // Address often contains both UA and RU addressed. api.visicom.ua is
//   // sometimes fine about that, but sometimes confused.
//   const addresses = addressLine.split(" / ").map((a) => a.trim());
//   // Assume the longest one is the most detailed one.
//   let maxLen = 0;
//   let bestAddress = undefined;
//   for (const address of addresses) {
//     const len = address.length;
//     if (len > maxLen) {
//       maxLen = len;
//       bestAddress = address;
//     }
//   }
//   return bestAddress;
// }

function extractBestAddress(addressLine) {
  if (!addressLine) {
    return undefined;
  }
  // Try to use the address in Russian.
  return addressLine.split(" / ")[0].trim();
}

function extractFeatures(address, entry) {
  if (entry.type === "Feature") {
    return [entry];
  } else if (entry.type === "FeatureCollection") {
    return entry.features;
  } else {
    console.warn(
      "Unexpected entry type: ",
      entry.type,
      " in ",
      entry,
      " for ",
      address
    );
    return undefined;
  }
}

function cleanStreetName(streetAddress) {
  return streetAddress.replace(/ *,? *?(дом|д|буд|б)? *[.-]* *$/, "");
}

function parseStreetAddress(address) {
  for (i = 0; i < address.length; i++) {
    const ch = address[i];
    if ("0" <= ch && ch <= "9") {
      return [cleanStreetName(address.slice(0, i)), address.slice(i)];
    }
  }
  return [address, undefined];
}

function extractAddress(oldEntry, oldStreetAddress, features) {
  const [oldStreet, oldHouseNo] = parseStreetAddress(oldStreetAddress);
  const p = features ? features[0].properties : {};
  const settlement = p.settlement
    ? p.settlement.split("(")[0].trim() || oldEntry.city
    : oldEntry.city;
  let street;
  if (p.street) {
    street = `${p.street_type || ""} ${p.street}`.trim();
  } else {
    street = oldStreet;
  }
  const houseNo = p.house_no || oldHouseNo;
  return [settlement, street, houseNo];
}

function extractCoords(features) {
  const coordCandidates = [];
  for (const feature of features) {
    const geo_centroid = feature.geo_centroid;
    if (!geo_centroid) {
      console.warn("Missing geo_centroid: ", feature);
      continue;
    }
    if (geo_centroid.type !== "Point") {
      console.warn("Unexpected geo_centroid type: ", geo_centroid.type);
      continue;
    }
    const [long, lat] = geo_centroid.coordinates;
    const coords = [lat, long];
    if (coordCandidates.length === 0) {
      coordCandidates.push(coords);
    } else {
      // If we already coord candidates, check if they are close enough.
      let clusterFound = false;
      for (const prevCoords in coordCandidates) {
        const d = distance(coords, prevCoords);
        if (d <= COORD_DIST_THRESHOLD_KM) {
          // Keep earlier coord: according to
          // https://api.visicom.ua/ru/products/data-api/data-api-references/geocode
          // results are sorted by relevance by default, so the first ones
          // should be the most relevant.
          clusterFound = true;
          break;
        }
      }
      if (!clusterFound) {
        coordCandidates.push(coords);
      }
    }
  }

  if (coordCandidates.length === 0) {
    return undefined;
  }
  return coordCandidates;
}

async function fetchVisicomData(address) {
  const request = new URL(
    "https://api.visicom.ua/data-api/5.0/ru/geocode.json"
  );
  request.searchParams.set("text", address);
  request.searchParams.set("key", "9635b0d8ab7edfd1f8a15eebd1e1aaea");
  const response = await fetch(request);
  return await response.json();
}

async function processData(allData) {
  const totalEntries = allData.entries.length;
  for (const [entryIdx, entry] of allData.entries.entries()) {
    if (entryIdx % 100 === 0) {
      console.log(`Doing: ${entryIdx} / ${totalEntries}`);
    }

    // if ((entry.status || "").toUpperCase() === "ВЫВЕЗЛИ") {
    //   continue;
    // }

    const streetAddress = extractBestAddress(entry.address);
    const city = entry.city;
    if (!streetAddress || !city) {
      continue;
    }
    const fullAddress = `${streetAddress}, ${city}`;

    const visicomData = await fetchVisicomData(fullAddress);
    const features = extractFeatures(fullAddress, visicomData);

    const russianAddress = extractAddress(entry, streetAddress, features);
    if (russianAddress) {
      const [settlement, street, houseNo] = russianAddress;
      entry.ruAddressSettlement = settlement;
      entry.ruAddressStreet = street;
      entry.ruAddressHouseNo = houseNo;
    }

    if (features === undefined) {
      continue;
    }

    const coordCandidates = extractCoords(features);
    if (coordCandidates === undefined) {
      continue;
    }
    let warning;
    if (coordCandidates.length === 1) {
      const oldCoords = entry.coords;
      if (oldCoords) {
        const d = distance(oldCoords, coordCandidates[0]);
        if (d > COORD_DIST_THRESHOLD_KM) {
          warning = `Координаты изменились на ${d.toFixed(1)} км`;
        }
      }
    } else {
      const MAX_SHOW = 10;
      let showCoords;
      if (coordCandidates.length <= MAX_SHOW) {
        showCoords = coordCandidates;
      } else {
        showCoords = coordCandidates.slice(0, MAX_SHOW);
        showCoords.push("...");
      }
      warning =
        "Найдено несколько вариантов координат: " + showCoords.join(", ");
    }

    entry.visicomCoords = serializeCoords(coordCandidates[0]);
    if (warning) {
      console.warn(warning, " for ", fullAddress);
      entry.visicomWarning = warning;
    }
  }
}

async function main() {
  const allData = JSON.parse(fs.readFileSync("entries.json", "utf-8"));
  await processData(allData);
  fs.writeFileSync(
    "entries-visicom-ua.json",
    JSON.stringify(allData, null, "\t")
  );
}

main();
