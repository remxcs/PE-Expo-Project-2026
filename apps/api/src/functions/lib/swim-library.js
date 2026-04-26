const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");

let cachedLibrary = null;

function getLibraryPath() {
  return path.resolve(__dirname, "../../../../../swim_set_library_v1.json");
}

function buildStableSwimSetId(set) {
  if (typeof set?.id === "string" && set.id.trim()) {
    return set.id.trim();
  }

  const stablePayload = JSON.stringify({
    text: set?.text ?? "",
    type: set?.type ?? "",
    reps: set?.reps ?? null,
    distance: set?.distance ?? null,
    distance_unit: set?.distance_unit ?? "",
    total_distance: set?.total_distance ?? null,
    time_target: set?.time_target ?? null,
    rest: set?.rest ?? null,
    strokes: Array.isArray(set?.strokes) ? set.strokes : [],
    equipment: Array.isArray(set?.equipment) ? set.equipment : [],
    training_focus: Array.isArray(set?.training_focus) ? set.training_focus : [],
    training_focus_certainty: set?.training_focus_certainty ?? {},
    intensity: set?.intensity ?? null,
    source: set?.source ?? "",
    tags: Array.isArray(set?.tags) ? set.tags : []
  });

  return `swim-set-${createHash("sha1").update(stablePayload).digest("hex").slice(0, 12)}`;
}

function loadSwimLibrary() {
  if (cachedLibrary) {
    return cachedLibrary;
  }

  const rawContents = fs.readFileSync(getLibraryPath(), "utf8");
  const parsedContents = JSON.parse(rawContents);
  cachedLibrary = (parsedContents.sets ?? []).map((set) => ({
    id: buildStableSwimSetId(set),
    ...set
  }));
  return cachedLibrary;
}

module.exports = {
  buildStableSwimSetId,
  loadSwimLibrary
};
