// Shared by the moderation, report and live-operations tests: a real server with an admin key, a small admin client and
// players that sit in match and party rooms through the Colyseus SDK.
import { randomUUID } from "node:crypto";
import { Client, type Room } from "@colyseus/sdk";
import { config, startServer, waitFor, type TestServer } from "../support/server.js";

/** A decoded JSON answer; the tests look at the fields they care about. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;
export interface Reply {
  status: number;
  data: Json;
}

export interface Account {
  id: string;
  token: string;
  username: string;
}

/** A player in a room, with everything the room sent it. */
export interface Seat {
  room: Room;
  account: Account;
  notices: string[];
  chats: { senderId: string; senderName: string; text: string }[];
  /** The close code once the room closed the connection. */
  closed?: number;
}

export interface Fixture {
  server: TestServer;
  adminKey: string;
  /** A call to /api/admin as the console makes it. */
  admin(method: "GET" | "POST", path: string, body?: unknown, operator?: string): Promise<Reply>;
  /** A call to /api, signed in when a token is given. */
  api(method: "GET" | "POST", path: string, token?: string, body?: unknown): Promise<Reply>;
  account(prefix?: string): Promise<Account>;
  /** Creates a private lobby (no room id) or joins the one with this id. */
  sit(account: Account, roomId?: string): Promise<Seat>;
  /** Creates a party (no room id) or joins the one with this id. */
  squad(account: Account, roomId?: string): Promise<Seat>;
  stop(): Promise<void>;
}

const joinOptions = { protocol: config.protocol, revision: config.revision, name: "Spoofed" };

function watch(room: Room, account: Account): Seat {
  const seat: Seat = { room, account, notices: [], chats: [] };
  room.reconnection.enabled = false;
  room.onMessage("notice", (notice: string) => seat.notices.push(notice));
  room.onMessage("chat", (json: string) => seat.chats.push(JSON.parse(json)));
  for (const type of ["presence", "reconnectWindow", "identity", "state", "search", "cancelled"])
    room.onMessage(type, () => {});
  room.onStateChange(() => {});
  room.onLeave(code => {
    seat.closed = code;
  });
  return seat;
}

/** A server with its own schema and a random admin key. */
export async function startFixture(): Promise<Fixture> {
  const adminKey = randomUUID();
  const server = await startServer({ adminKey });
  const open: Room[] = [];
  let counter = 0;

  const call = async (url: string, method: string, headers: Record<string, string>, body?: unknown) => {
    const response = await fetch(server.url + url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };

  return {
    server,
    adminKey,
    admin: (method, path, body, operator = "Rita") =>
      call("/api/admin" + path, method, { Authorization: "Bearer " + adminKey, "X-GM-Operator": operator }, body),
    api: (method, path, token = "", body) =>
      call("/api" + path, method, token ? { Authorization: "Bearer " + token } : {}, body),
    async account(prefix = "player") {
      const username = `${prefix}_${++counter}_${randomUUID().slice(0, 4)}`;
      const signedIn = await server.container.accounts.register({ username, password: "test-only-password" });
      return { id: signedIn.profile.id, token: signedIn.token, username };
    },
    async sit(account, roomId = "") {
      const options = { ...joinOptions, sessionToken: account.token };
      const client = new Client(server.url);
      const room = roomId ? await client.joinById(roomId, options) : await client.create("party_private", options);
      open.push(room);
      return watch(room, account);
    },
    async squad(account, roomId = "") {
      const options = { ...joinOptions, sessionToken: account.token };
      const client = new Client(server.url);
      const room = roomId ? await client.joinById(roomId, options) : await client.create("squad", options);
      open.push(room);
      return watch(room, account);
    },
    async stop() {
      for (const room of open) if (room.connection.isOpen) await room.leave().catch(() => {});
      await server.stop();
    },
  };
}

export { waitFor };
