// Composio session connect demo: a chat agent with every Composio toolkit,
// where connecting an app first lets the user choose what the agent may do in it.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Composio } from "@composio/core";
import { OpenAIAgentsProvider } from "@composio/openai-agents";
import { Agent, run, setTracingDisabled } from "@openai/agents";

for (const key of ["COMPOSIO_API_KEY", "OPENAI_API_KEY"])
  if (!process.env[key]) throw Error(`Set ${key} in .env`);

setTracingDisabled(true);
const PORT = Number(process.env.PORT || 3941);
const APP_URL = `http://localhost:${PORT}`;
const USER_ID = process.env.COMPOSIO_USER_ID || "demo_user";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";

const composio = new Composio({
  apiKey: process.env.COMPOSIO_API_KEY,
  provider: new OpenAIAgentsProvider(),
});

// Access choices -> per-toolkit tool policy, using tool behavior hint tags.
const ACCESS = {
  read: { tags: { enable: ["readOnlyHint"], disable: ["destructiveHint"] } },
  safe: { tags: { disable: ["destructiveHint"] } },
  full: { disable: [] },
};

const INSTRUCTIONS = `You are a helpful assistant that can use any app through Composio tools.
- Use COMPOSIO_SEARCH_TOOLS to find tools, then COMPOSIO_MULTI_EXECUTE_TOOL to run them.
- If an app is not connected, call COMPOSIO_MANAGE_CONNECTIONS for it. When it returns
  "connect_button_shown", tell the user in one short sentence to click the connect button below.
  The app resumes automatically after login, so never ask the user to reply or say done.
- Connection state changes: never assume an app is still disconnected, always try again.
- Finish the task in this turn and summarize results briefly.`;

// One chat per browser tab cookie: { session, history, links: { toolkit: { url, accessSet } } }
const chats = new Map();

async function getChat(req, res) {
  const id = req.headers.cookie?.match(/chat=([\w-]+)/)?.[1];
  if (chats.has(id)) return chats.get(id);
  const newId = randomUUID();
  // 1. Create a Composio session for the user. No toolkit list = every toolkit is available.
  //    callbackUrl: where Composio sends the login tab once the user finishes connecting.
  const session = await composio.sessions.create(USER_ID, {
    manageConnections: { enable: true, callbackUrl: `${APP_URL}/connected` },
  });
  const chat = { session, history: [], links: {} };
  chats.set(newId, chat);
  res.setHeader("Set-Cookie", `chat=${newId}; HttpOnly; SameSite=Lax; Path=/`);
  return chat;
}

async function handleChat(chat, message) {
  const buttons = [];
  // 2. Session tools for the agent. The SDK executes them; afterExecute lets us
  //    swap the connect link for a button so the URL never goes through the model.
  const tools = await chat.session.tools({
    afterExecute: async ({ toolSlug, result }) => {
      if (toolSlug !== "COMPOSIO_MANAGE_CONNECTIONS") return result;
      for (const [toolkit, item] of Object.entries(result.data?.results || {})) {
        if (!item?.redirect_url) continue;
        chat.links[toolkit] = { url: item.redirect_url, accessSet: false };
        buttons.push(toolkit);
      }
      return {
        data: buttons.length
          ? { status: "connect_button_shown", toolkits: buttons }
          : result.data,
        error: null,
      };
    },
  });
  const agent = new Agent({
    name: "Assistant",
    model: MODEL,
    instructions: INSTRUCTIONS,
    tools,
    modelSettings: MODEL.startsWith("gpt-5") ? { reasoning: { effort: "low" } } : {},
  });
  const result = await run(agent, [...chat.history, { role: "user", content: message }], { maxTurns: 12 });
  // Keep the last ~10 user turns. Cut only at a user message so a tool call
  // is never separated from its output (OpenAI rejects orphaned outputs).
  const userTurns = result.history.flatMap((item, i) => (item.role === "user" ? [i] : []));
  chat.history = result.history.slice(userTurns.at(-10) ?? 0);
  return { message: result.finalOutput || "", connect: buttons };
}

async function setAccess(chat, toolkit, access) {
  if (!ACCESS[access]) throw Error("Unknown access option");
  const link = chat.links[toolkit];
  if (!link) throw Error("No connect link for this app");
  // 3. Patch only this toolkit's tool policy; other toolkits keep their settings.
  // session.config reports rules as enabled/disabled; update() takes enable/disable.
  const current = JSON.parse(
    JSON.stringify(chat.session.config?.tools || {}).replace(/"(en|dis)abled":/g, '"$1able":'),
  );
  await chat.session.update({ tools: { ...current, [toolkit]: ACCESS[access] } });
  link.accessSet = true;
  // 4. Send the user to the same link the agent created.
  return { url: link.url };
}

const readJson = async (req) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
};
const sendJson = (res, data, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
};

http
  .createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, APP_URL);
      if (req.method === "GET" && pathname === "/") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.end(await readFile(new URL("./index.html", import.meta.url)));
      }
      // 5. Composio redirects the login tab here; it tells the chat tab to resume.
      if (req.method === "GET" && pathname === "/connected") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.end(await readFile(new URL("./connected.html", import.meta.url)));
      }
      if (req.method !== "POST") return sendJson(res, { error: "Not found" }, 404);
      if (req.headers.origin !== APP_URL) return sendJson(res, { error: "Bad origin" }, 403);
      const chat = await getChat(req, res);
      const body = await readJson(req);
      if (pathname === "/api/chat") return sendJson(res, await handleChat(chat, String(body.message || "")));
      if (pathname === "/api/access") return sendJson(res, await setAccess(chat, body.toolkit, body.access));
      sendJson(res, { error: "Not found" }, 404);
    } catch (e) {
      console.error(e);
      sendJson(res, { error: e.message }, 500);
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Open ${APP_URL}`));
