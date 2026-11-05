import { definePlugin } from "@pipoca/plugins";

export const notes = definePlugin({
  id: "notes",
  title: "Notes",
  description: "Keeps notes for people and the team",
  works: ["personal", "team"],
  server: async () => import("./notes-server"),
});

export const diary = definePlugin({
  id: "diary",
  title: "Diary",
  description: "Keeps a diary for each person",
  server: async () => import("./diary-server"),
});
