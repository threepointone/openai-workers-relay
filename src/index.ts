import { RealtimeClient } from "@openai/realtime-api-beta";

type Env = {
  OPENAI_API_KEY: string;
};

const MODEL = "gpt-4o-realtime-preview-2024-10-01";

async function createRealtimeClient(
  request: Request,
  env: Env,
  ctx: ExecutionContext
) {
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);

  let realtimeClient: RealtimeClient | null = null;

  server.accept();

  // Copy protocol headers
  const responseHeaders = new Headers();
  const protocolHeader = request.headers.get("Sec-WebSocket-Protocol");
  let apiKey = env.OPENAI_API_KEY;
  if (protocolHeader) {
    const requestedProtocols = protocolHeader.split(",").map((p) => p.trim());
    if (requestedProtocols.includes("realtime")) {
      // Not exactly sure why this protocol needs to be accepted
      responseHeaders.set("Sec-WebSocket-Protocol", "realtime");
    }

    for (const protocol of requestedProtocols) {
      if (protocol.startsWith("openai-insecure-api-key.")) {
        const parsedApiKey = protocol
          .slice("openai-insecure-api-key.".length)
          .trim();
        if (parsedApiKey.length > 0 && parsedApiKey !== "null") {
          apiKey = parsedApiKey;
        }
      }
    }
  }

  const url = new URL(request.url);
  const model = url.searchParams.get("model") ?? MODEL;

  if (!apiKey) {
    return new Response("Missing API key", { status: 401 });
  }

  // Create RealtimeClient
  try {
    console.log("Creating RealtimeClient");
    realtimeClient = new RealtimeClient({
      apiKey,
    });
  } catch (e) {
    console.error(`Error creating RealtimeClient: ${e}`);
    server.close();
    return new Response("Error creating RealtimeClient", { status: 500 });
  }

  // Relay: OpenAI Realtime API Event -> Client
  realtimeClient.realtime.on("server.*", (event: { type: string }) => {
    // console.log(`Relaying "${event.type}" to Client`);
    server.send(JSON.stringify(event));
  });

  realtimeClient.realtime.on("close", () => {
    console.log("Closing server-side because I received a close event");
    server.close();
  });

  // Relay: Client -> OpenAI Realtime API Event
  const messageQueue: string[] = [];

  server.addEventListener("message", (event: MessageEvent) => {
    const messageHandler = (data: string) => {
      try {
        const parsedEvent = JSON.parse(data);
        // console.log(`Relaying "${event.type}" to OpenAI`);
        realtimeClient.realtime.send(parsedEvent.type, parsedEvent);
      } catch (e) {
        console.error(`Error parsing event from client: ${data}`);
      }
    };

    const data =
      typeof event.data === "string" ? event.data : event.data.toString();
    if (!realtimeClient.isConnected()) {
      messageQueue.push(data);
    } else {
      messageHandler(data);
    }
  });

  server.addEventListener("close", () => {
    console.log("Closing server-side because the client closed the connection");
    realtimeClient.disconnect();
  });

  // Connect to OpenAI Realtime API
  try {
    console.log(`Connecting to OpenAI...`);
    await realtimeClient.connect();
    console.log(`Connected to OpenAI successfully!`);
    while (messageQueue.length) {
      const message = messageQueue.shift();
      if (message) {
        server.send(message);
      }
    }
  } catch (e) {
    if (e instanceof Error) {
      console.error(`Error connecting to OpenAI: ${e.message}`);
    } else {
      console.error(`Error connecting to OpenAI: ${e}`);
    }
    return new Response("Error connecting to OpenAI", { status: 500 });
  }

  return new Response(null, {
    status: 101,
    headers: responseHeaders,
    webSocket: client,
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader === "websocket") {
      return createRealtimeClient(request, env, ctx);
    }

    return new Response("Expected Upgrade: websocket", { status: 426 });
  },
};