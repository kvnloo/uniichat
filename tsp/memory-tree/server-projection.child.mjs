// Run the real Server.ts Chat.eye/Chat.show logic under Bun, outside the
// standalone native TypeScript graph. The parent test owns disposable paths.
import { Chat } from "../../Server.ts";

function project(chat) {
  const delivered = [];
  // These are already-taught nodes, as in the original in-process regression.
  // Chat.show still computes and serializes the real model/display projection.
  const seen = new Set(["0+4", "4+4", "0+8", "8+8", "0+16"]);
  const sock = {
    data: { seen },
    send(body) { delivered.push(JSON.parse(body)); },
  };
  Chat.show(chat, sock);
  const view = delivered.find(message => message.$ === "view");
  if (view === undefined) throw new Error("Chat.show did not send a view");
  return view;
}

// A model call freezes two context blocks before an import overlaps the root.
const mem = { count: 16, view: { parts: [{ l: 2, i: 0 }, { l: 2, i: 1 }] } };
const eye = Chat.eye(mem, 8);
const context = { turn: 8, parts: eye.parts.map(([id, n]) => [id, n]) };
const chat = { mem, eye, context, busy: true, batch: { a: 8, b: 16 } };
const during = project(chat);

// Completing the import moves display memory, not the model's frozen call.
mem.view.parts = [{ l: 4, i: 0 }];
chat.batch = null;
chat.eye = Chat.eye(mem, 16);
const after = project(chat);

// A separately compacted turn, then idle and cold reload without a call.
const compactMem = { count: 16, view: { parts: [{ l: 4, i: 0 }] } };
const compactEye = Chat.eye(compactMem, 16);
const compactChat = {
  mem: compactMem, eye: compactEye, busy: true, batch: null,
  context: { turn: 16, parts: [[0, 16]] },
};
const compacted = project(compactChat);
compactChat.busy = false;
compactChat.context = null;
const idle = project(compactChat);
const reload = project({
  mem: compactMem, eye: Chat.eye(compactMem, 16),
  busy: false, batch: null, context: null,
});

console.log("UNII_MEMORY_PROJECTIONS:" + JSON.stringify({
  eye: eye.parts, during, after, compacted, idle, reload,
}));
process.exit(0);
