import type { SkillKind } from "./skill-kind.js";
import { planarLength } from "../planar-length.js";

/**
 * Stumble Guys style dive (dive slot): a hop forward from the ground or a lunge in the air, a belly landing that slides
 * to a stop, then getting up. Aims at the stick, or where the runner last faced when the stick is idle.
 * Twin: Core/Simulation/Skills/DiveSkill.cs.
 */
export const dive: SkillKind = {
  slot: "dive",
  validate(skill, check) {
    check.number(skill.speed, 0, 40, skill.id + ".speed");
    check.number(skill.lift, 0, 30, skill.id + ".lift");
    check.number(skill.airLift, 0, 30, skill.id + ".airLift");
    check.number(skill.landedSeconds, 0, 3, skill.id + ".landedSeconds");
    check.number(skill.recoverSeconds, 0, 3, skill.id + ".recoverSeconds");
    check.number(skill.friction, 0, 200, skill.id + ".friction");
  },
  start(runner, skill) {
    const stickLength = planarLength(runner.inputX, runner.inputZ);
    const directionX = stickLength > 0.1 ? runner.inputX / stickLength : runner.facingX;
    const directionZ = stickLength > 0.1 ? runner.inputZ / stickLength : runner.facingZ;
    const speed = Math.max(skill.speed, planarLength(runner.vx, runner.vz));
    runner.vx = directionX * speed;
    runner.vz = directionZ * speed;
    runner.vy = runner.grounded ? skill.lift : skill.airLift;
    runner.facingX = directionX;
    runner.facingZ = directionZ;
    runner.grounded = false;
  },
  slide(runner, skill, dt) {
    if (!runner.grounded) return;
    const speed = planarLength(runner.vx, runner.vz);
    const scale = speed > 0 ? Math.max(0, speed - skill.friction * dt) / speed : 0;
    runner.vx *= scale;
    runner.vz *= scale;
  },
};
