import type { Runner } from "./runner.js";

// Authoritative animation: every tick the server picks each runner's pose, so all clients play the same clip from
// the same tick. Wire pose = 1 + CharacterPose ordinal (Core/Presentation/CharacterPresentationState.cs); 0 is
// reserved for unsynchronized cosmetic copies. Mirrored by Core/Simulation/NetworkAnimationRules.cs.
export const enum Pose {
  Idle = 0,
  Run = 1,
  JumpStart = 2,
  JumpLoop = 3,
  Fall = 4,
  DashStart = 5,
  DashLoop = 6,
  Land = 7,
  Hit = 8,
  Ragdoll = 9,
  Recover = 10,
  Qualified = 11,
  Victory = 12,
  Eliminated = 13,
  Emote = 14,
  Punch = 15,
}

export function animate(
  runner: Runner,
  tick: number,
  tickRate: number,
  phase: string,
  winners: string[],
  round: number,
): void {
  let old = (runner.animationState || 1) - 1;
  let age = (tick - (runner.animationTick || 0)) / tickRate;
  const fresh = (clock: number) => clock > 0 && clock === tick;
  const spawn = !runner.animationState || runner.animationRound !== round || fresh(runner.respawnTick);
  if (spawn) {
    age = 0;
    old = Pose.Idle;
  }
  const planarSpeedSquared = runner.vx * runner.vx + runner.vz * runner.vz;
  let pose: Pose;
  if (runner.status === "eliminated") pose = Pose.Eliminated;
  else if (phase === "finished" && winners.includes(runner.id)) pose = Pose.Victory;
  else if (fresh(runner.hitTick)) pose = Pose.Hit;
  else if (old === Pose.Hit && age < 0.08) pose = Pose.Hit;
  else if (runner.knockedDown) pose = Pose.Ragdoll;
  else if ((old === Pose.Ragdoll || old === Pose.Hit) && runner.grounded) pose = Pose.Recover;
  else if (old === Pose.Recover && age < 0.3) pose = Pose.Recover;
  else if (runner.skillPhase === 3) pose = Pose.Recover;
  else if (runner.status === "qualified") pose = Pose.Qualified;
  else if (fresh(runner.diveTick)) pose = Pose.DashStart;
  else if (old === Pose.DashStart && runner.dashing && age < 0.1) pose = Pose.DashStart;
  else if (runner.dashing) pose = Pose.DashLoop;
  else if (fresh(runner.actionTick)) pose = Pose.Punch;
  else if (old === Pose.Punch && age < 0.3) pose = Pose.Punch;
  else if (fresh(runner.jumpTick) || fresh(runner.launchTick)) pose = Pose.JumpStart;
  else if (old === Pose.JumpStart && !runner.grounded && age < 0.1) pose = Pose.JumpStart;
  else if (!runner.grounded) pose = runner.vy < -0.2 ? Pose.Fall : Pose.JumpLoop;
  else if (fresh(runner.landTick)) pose = Pose.Land;
  else if (old === Pose.Land && age < 0.13) pose = Pose.Land;
  else if (runner.emote && runner.emoteUntil > tick && planarSpeedSquared < 0.04) pose = Pose.Emote;
  else pose = planarSpeedSquared > 0.04 ? Pose.Run : Pose.Idle;
  if (spawn || pose !== old) {
    runner.animationTick = tick;
    runner.animationState = pose + 1;
  }
  runner.animationState ||= 1;
  runner.animationTick ||= 0;
  runner.animationRound = round;
}
