import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const backendPort = "8010";
const windows = process.platform === "win32";
const pythonCandidates = windows
  ? [join(projectRoot, "venv", "Scripts", "python.exe")]
  : [join(projectRoot, "venv", "bin", "python")];
const python = pythonCandidates.find(existsSync) || process.env.PYTHON || (windows ? "python" : "python3");
const npm = windows ? "npm.cmd" : "npm";
const children = { backend: null, frontend: null };
let closing = false;
let resolveShutdown;
let keepAlive = null;
const shutdownRequested = new Promise((resolve) => { resolveShutdown = resolve; });
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function runSetup(command, args, label) {
  const isWindowsCommand = windows && command.toLowerCase().endsWith(".cmd");
  const executable = isWindowsCommand ? (process.env.ComSpec || "cmd.exe") : command;
  const commandArgs = isWindowsCommand
    ? ["/d", "/s", "/c", [command.replace(/\.cmd$/i, ""), ...args].join(" ")]
    : args;
  const result = spawnSync(executable, commandArgs, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: false,
    windowsHide: false,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error ? ": " + result.error.message : " (exit code " + result.status + ")";
    throw new Error(label + " failed" + detail + ".");
  }
}

function ensureDependencies() {
  const pythonCheck = spawnSync(python, ["-c", "import fastapi, uvicorn"], {
    cwd: projectRoot,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
  if (pythonCheck.error || pythonCheck.status !== 0) {
    console.log("Installing backend requirements into the project environment...");
    runSetup(python, ["-m", "pip", "install", "-r", join(projectRoot, "requirements.txt")], "Backend setup");
  }

  const viteEntrypoints = [
    join(projectRoot, "frontend", "node_modules", "vite", "bin", "vite.js"),
    join(projectRoot, "node_modules", "vite", "bin", "vite.js"),
  ];
  if (!viteEntrypoints.some(existsSync)) {
    console.log("Installing frontend workspace packages...");
    runSetup(npm, ["install"], "Frontend setup");
  }
}

function stopChild(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (windows) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    child.kill("SIGTERM");
  }
}

async function stopAll(code = 0) {
  if (closing) return;
  closing = true;
  process.exitCode = code;
  if (keepAlive) clearInterval(keepAlive);
  stopChild(children.frontend);
  stopChild(children.backend);
  await wait(250);
  resolveShutdown();
}

function monitor(child, name) {
  child.once("error", (error) => {
    console.error(name + " could not start: " + error.message);
    void stopAll(1);
  });
  child.once("exit", (code, signal) => {
    if (closing) return;
    if (signal) console.log(name + " stopped (" + signal + ").");
    else if (code) console.error(name + " exited with code " + code + ".");
    void stopAll(code || 0);
  });
}

async function existingBackend() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch("http://127.0.0.1:" + backendPort + "/", { signal: controller.signal });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload.message === "AURALYTIX Research API is running";
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function existingFrontend() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch("http://127.0.0.1:3000/", { signal: controller.signal });
    if (!response.ok) return false;
    const page = await response.text();
    return page.includes("<title>AURALYTIX AI | Research Desk</title>");
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function waitForBackend() {
  const healthUrl = "http://127.0.0.1:" + backendPort + "/health";
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (closing) throw new Error("Startup was stopped.");
    if (children.backend?.exitCode !== null && children.backend?.exitCode !== undefined) {
      throw new Error("Backend stopped before becoming ready (exit code " + children.backend.exitCode + ").");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 900);
    try {
      const response = await fetch(healthUrl, { signal: controller.signal });
      if (response.ok) {
        console.log("Backend ready at " + healthUrl);
        return;
      }
    } catch {
      // Wait for backend imports and local port startup.
    } finally {
      clearTimeout(timeout);
    }
    await wait(350);
  }
  throw new Error("Backend did not become ready at " + healthUrl + " within 45 seconds.");
}

async function main() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 20) {
    console.error("AURALYTIX requires Node.js 20 or newer. Update Node.js, then start again.");
    await stopAll(1);
    return;
  }

  try {
    ensureDependencies();
  } catch (error) {
    console.error(error.message);
    await stopAll(1);
    return;
  }

  if (await existingBackend()) {
    console.log("AURALYTIX backend is already healthy at http://127.0.0.1:" + backendPort);
  } else {
    if (!(await portAvailable(Number(backendPort)))) {
      console.error("Port " + backendPort + " is occupied by another service. Stop that service, then start AURALYTIX again.");
      await stopAll(1);
      return;
    }
    console.log("Starting AURALYTIX backend...");
    children.backend = spawn(python, [
      "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", backendPort,
    ], { cwd: projectRoot, stdio: "inherit", windowsHide: false });
    monitor(children.backend, "Backend");

    try {
      await waitForBackend();
    } catch (error) {
      if (!closing) {
        console.error(error.message);
        await stopAll(1);
      }
      return;
    }
  }
  if (closing) return;

  if (await existingFrontend()) {
    console.log("AURALYTIX frontend is already available at http://localhost:3000/");
    return;
  }
  if (!(await portAvailable(3000))) {
    console.error("Port 3000 is occupied by another service. Stop that service, then start AURALYTIX again.");
    await stopAll(1);
    return;
  }

  console.log("Starting AURALYTIX frontend...");
  const viteEntrypoint = [
    join(projectRoot, "frontend", "node_modules", "vite", "bin", "vite.js"),
    join(projectRoot, "node_modules", "vite", "bin", "vite.js"),
  ].find(existsSync);
  if (!viteEntrypoint) {
    console.error("Vite is missing after dependency setup.");
    await stopAll(1);
    return;
  }
  children.frontend = spawn(process.execPath, [viteEntrypoint], {
    cwd: join(projectRoot, "frontend"),
    stdio: "inherit",
    windowsHide: false,
  });
  monitor(children.frontend, "Frontend");
}

process.on("SIGINT", () => { void stopAll(0); });
process.on("SIGTERM", () => { void stopAll(0); });

await main();
if (!closing && !children.backend && !children.frontend) {
  keepAlive = setInterval(() => {}, 1000);
}
await shutdownRequested;
