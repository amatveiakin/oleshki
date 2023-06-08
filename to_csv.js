const fs = require("fs");

function serializeCoords(coords) {
  if (!coords) {
    return undefined;
  }
  const [lat, long] = coords;
  return `${lat}, ${long}`;
}

const allData = JSON.parse(fs.readFileSync("entries-visicom-ua.json", "utf-8"));
const lines = [];
const columns = [
  "id",
  "address",
  "city",
  "coords",
  "ruAddressSettlement",
  "ruAddressStreet",
  "ruAddressHouseNo",
  "visicomCoords",
  "visicomWarning",
];
lines.push(columns.join("\t"));
for (const entry of allData.entries) {
  const row = columns.map((column) => {
    if (column === "coords") {
      return serializeCoords(entry.coords) || "";
    } else {
      return (entry[column] || "").replace(/\n/g, "\\n");
    }
  });
  lines.push(row.join("\t"));
}
fs.writeFileSync("entries-visicom-ua.csv", lines.join("\n"));
