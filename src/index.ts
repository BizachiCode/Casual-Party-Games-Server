/**
 * Process entry point (`npm start`, `npm run start:prod`). Listens on PORT (default 2567).
 * HOST binds one interface instead of all of them; the local dev backend uses 127.0.0.1.
 */
import { listen } from "@colyseus/tools";
import app, { party } from "./app.config.js";

const port = Number(process.env.PORT || 2567);
if (process.env.HOST) await app.listen(port, process.env.HOST);
else await listen(app, port);

const { protocol, revision } = party.container.content.config;
console.log(`Casual Party server listening on ${port} (protocol ${protocol}, ${revision})`);
