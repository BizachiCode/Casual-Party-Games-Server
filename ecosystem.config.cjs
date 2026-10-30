/**
 * PM2 deployment (also used by Colyseus Cloud). See https://docs.colyseus.io/deployment
 *
 * One process: live matches, lobby invitations and service metrics live in this process's memory.
 * Run more instances only behind a sticky load balancer, with REDIS_URL set for seats and presence.
 */
module.exports = {
  apps: [
    {
      name: "casual-party-server",
      script: "build/index.js",
      time: true,
      watch: false,
      instances: 1,
      exec_mode: "fork",
      wait_ready: true,
      kill_timeout: 60000,
      max_memory_restart: "512M",
    },
  ],
};
