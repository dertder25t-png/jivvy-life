import { SQLDatabase } from "encore.dev/storage/sqldb";

// Single shared database "jivvy"; all migrations (auth + sync tables) live here.
export const db = new SQLDatabase("jivvy", { migrations: "./migrations" });
