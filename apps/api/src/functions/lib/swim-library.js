const fs = require("fs");
const path = require("path");

let cachedLibrary = null;

function getLibraryPath() {
  return path.resolve(__dirname, "../../../../../swim_set_library_v1.json");
}

function loadSwimLibrary() {
  if (cachedLibrary) {
    return cachedLibrary;
  }

  const rawContents = fs.readFileSync(getLibraryPath(), "utf8");
  const parsedContents = JSON.parse(rawContents);
  cachedLibrary = (parsedContents.sets ?? []).map((set, index) => ({
    id: `swim-set-${index + 1}`,
    ...set
  }));
  return cachedLibrary;
}

module.exports = {
  loadSwimLibrary
};
