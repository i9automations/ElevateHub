const path = require("node:path");
const { JsonStore } = require("./json-store");
const { SupabaseStore } = require("./supabase-store");

function createStore() {
  const mode = String(process.env.V2_DATA_STORE || "").toLowerCase();
  const hasSupabase = !!(process.env.V2_SUPABASE_URL || process.env.SUPABASE_URL);
  if (mode === "supabase" || (!mode && hasSupabase)) {
    return new SupabaseStore();
  }

  const dataDir = path.join(__dirname, "..", "data");
  const dbFile = process.env.V2_DB_FILE || path.join(dataDir, "db.json");
  return new JsonStore({ dbFile });
}

module.exports = { createStore };
