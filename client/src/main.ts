import { Plugin } from "obsidian";

export default class NewLiveSyncPlugin extends Plugin {
  async onload() {
    console.log("New LiveSync loaded");
  }
  onunload() {
    console.log("New LiveSync unloaded");
  }
}
