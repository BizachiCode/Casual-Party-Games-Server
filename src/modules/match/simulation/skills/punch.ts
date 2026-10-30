import type { SkillDefinition } from "../../../content/content.types.js";
import { knockBack } from "../effects.js";
import type { Runner } from "../runner.js";
import type { SkillKind, SkillWorld } from "./skill-kind.js";

/** Height difference, in metres, a punch still reaches across (a runner a step up or down). */
const PUNCH_HEIGHT = 1.4;

/**
 * Punch (action slot): a swing toward the stick, or where the runner faces, that throws back everyone within `reach`
 * metres inside `arc` degrees either side of that direction, at `speed` m/s with `lift` m/s upward and `stun` seconds
 * without control. It knocks them down only when `knockdown` is set. The swing starts with a short dash forward at
 * `lunge` m/s (never slower than the runner already goes), which then fades like any other speed above the run speed.
 * Twin: Core/Simulation/Skills/PunchSkill.cs.
 */
export const punch: SkillKind = {
  slot: "action",
  validate(skill, check) {
    check.number(skill.speed, 0, 30, skill.id + ".speed");
    check.number(skill.lift, 0, 20, skill.id + ".lift");
    check.number(skill.reach, 0.5, 5, skill.id + ".reach");
    check.number(skill.arc, 10, 180, skill.id + ".arc");
    check.number(skill.stun, 0, 2, skill.id + ".stun");
    check.require(skill.knockdown === undefined || typeof skill.knockdown === "boolean", skill.id + ".knockdown");
    check.number(skill.lunge ?? 0, 0, 20, skill.id + ".lunge");
  },
  start(runner, skill) {
    const stickLength = Math.sqrt(runner.inputX * runner.inputX + runner.inputZ * runner.inputZ);
    if (stickLength > 0.1) {
      runner.facingX = runner.inputX / stickLength;
      runner.facingZ = runner.inputZ / stickLength;
    }
    const lunge = skill.lunge ?? 0;
    if (lunge > 0) {
      const planarSpeed = Math.sqrt(runner.vx * runner.vx + runner.vz * runner.vz);
      const speed = Math.max(lunge, planarSpeed + lunge * 0.3);
      runner.vx = runner.facingX * speed;
      runner.vz = runner.facingZ * speed;
    }
  },
  affect(user, runners, skill, world) {
    for (const target of runners) {
      if (!reaches(user, target, skill, world)) continue;
      const offsetX = target.x - user.x;
      const offsetZ = target.z - user.z;
      const distance = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ);
      const awayX = distance > 0.001 ? offsetX / distance : user.facingX;
      const awayZ = distance > 0.001 ? offsetZ / distance : user.facingZ;
      knockBack(
        target,
        awayX * skill.speed,
        skill.lift,
        awayZ * skill.speed,
        world.elapsed + skill.stun,
        !!skill.knockdown,
        world.tick,
      );
    }
  },
  useful(user, runners, skill, world) {
    return runners.some(target => reaches(user, target, skill, world));
  },
};

/** Whether the punch reaches this runner: another racer, not a teammate, not already reeling, in range and arc. */
function reaches(user: Runner, target: Runner, skill: SkillDefinition, world: SkillWorld): boolean {
  if (target === user || target.status !== "racing" || world.elapsed < target.hitUntil) return false;
  if (world.teamSize > 1 && user.team !== 0 && target.team === user.team) return false;
  if (Math.abs(target.y - user.y) > PUNCH_HEIGHT) return false;
  const offsetX = target.x - user.x;
  const offsetZ = target.z - user.z;
  const distance = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ);
  if (distance > skill.reach) return false;
  return offsetX * user.facingX + offsetZ * user.facingZ >= distance * Math.cos((skill.arc * Math.PI) / 180);
}
