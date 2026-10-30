/**
 * The Colyseus server this process runs, configured from the environment (see .env.example).
 * Rooms, HTTP routes and services are assembled in src/app; this file stays a one-liner for Colyseus Cloud.
 */
import { createPartyServer } from "./app/server.js";
import { loadSettings } from "./config/env.js";

export const party = createPartyServer(loadSettings());

export default party.server;
