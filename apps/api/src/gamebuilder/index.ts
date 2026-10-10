import { initWorkspace } from "../services/workspace.js";
import { GODOT_FILES } from "./godot2dArena.js";
import * as proc from "./procedural.js";

/** Writes the complete Godot 2D arena project (text files and generated placeholder assets) into a workspace. */
export function generateGodot2dArena(root: string, gitHome: string, name: string, description: string): void {
  const extra: Record<string, string | Buffer> = {};
  for (const [rel, content] of Object.entries(GODOT_FILES)) {
    if (rel !== "README.md") extra[rel] = content;
  }
  // Generated placeholder art and audio. Provenance and licence are recorded in ASSETS.md.
  extra["assets/sprites/player.png"] = proc.playerSprite();
  extra["assets/sprites/slime.png"] = proc.slimeSprite();
  extra["assets/sprites/floor.png"] = proc.floorTile();
  extra["assets/sprites/wall.png"] = proc.wallTile();
  extra["assets/audio/sfx_hit.wav"] = proc.sfxHit();
  extra["assets/audio/sfx_swing.wav"] = proc.sfxSwing();
  extra["assets/audio/sfx_pickup.wav"] = proc.sfxPickup();
  extra["assets/audio/sfx_death.wav"] = proc.sfxDeath();
  extra["assets/audio/sfx_damage.wav"] = proc.sfxDamage();
  extra["assets/audio/sfx_win.wav"] = proc.sfxWin();
  extra["assets/audio/music_loop.wav"] = proc.musicLoop();

  const template = GODOT_FILES["README.md"] ?? "";
  const body = template.replace(/^# [^\n]*\n+/, "");
  const readme = `# ${name}\n\n${description ? `${description}\n\n` : ""}${body}`;
  initWorkspace(root, gitHome, readme, extra);
}
