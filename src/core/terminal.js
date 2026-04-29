import pty from 'node-pty';
import os from 'os';
import logger from './logger.js';

class TerminalManager {
  constructor() {
    this.sessions = new Map();
    this.shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
    this.pendingNotifications = [];
  }

  spawn(sessionId, options = {}) {
    const {
      shell = this.shell,
      cwd = process.cwd(),
      env = process.env,
      cols = 80,
      rows = 24
    } = options;

    logger.debug(`Spawning terminal session: ${sessionId} (${shell})`);
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols,
      rows,
      cwd,
      env
    });

    const session = {
      pty: ptyProcess,
      buffer: '',
      cleanBuffer: '',
      id: sessionId,
      observers: [],
      lastActivity: Date.now(),
      idleTimer: null
    };

    ptyProcess.onData((data) => {
      session.buffer += data;
      const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
      session.cleanBuffer += cleanData;

      // Update activity and reset idle timer
      session.lastActivity = Date.now();
      this._resetIdleTimer(session);

      // Check pattern observers (one-shot)
      const remainingObservers = [];
      for (const obs of session.observers) {
        if (obs.pattern) {
          try {
            const regex = new RegExp(obs.pattern);
            if (regex.test(cleanData)) {
              this.pendingNotifications.push(`Pattern '${obs.pattern}' detected in session ${sessionId}`);
            } else {
              remainingObservers.push(obs);
            }
          } catch (err) {
            this.pendingNotifications.push(`Invalid regex pattern '${obs.pattern}' in session ${sessionId}: ${err.message}`);
            // Don't push to remainingObservers, effectively removing the broken observer
          }
        } else {
          remainingObservers.push(obs);
        }
      }
      session.observers = remainingObservers;

      // Limit buffer size to 1MB
      if (session.buffer.length > 1024 * 1024) {
        session.buffer = session.buffer.slice(-1024 * 1024);
      }
      if (session.cleanBuffer.length > 1024 * 1024) {
        session.cleanBuffer = session.cleanBuffer.slice(-1024 * 1024);
      }
    });

    ptyProcess.onExit(() => {
      this.pendingNotifications.push(`Session ${sessionId} has terminated.`);
      if (session.idleTimer) clearTimeout(session.idleTimer);
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  _resetIdleTimer(session) {
    if (session.idleTimer) clearTimeout(session.idleTimer);

    // Find observer with idleTimeout
    const idleObs = session.observers.find(o => o.idleTimeout);
    if (idleObs) {
      session.idleTimer = setTimeout(() => {
        this.pendingNotifications.push(`Session ${session.id} has been idle for ${idleObs.idleTimeout} seconds.`);
        // Remove this idle observer
        session.observers = session.observers.filter(o => o !== idleObs);
        session.idleTimer = null;
      }, idleObs.idleTimeout * 1000);
    }
  }

  addObserver(sessionId, { pattern, idleTimeout }) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.observers.push({ pattern, idleTimeout });
    if (idleTimeout) this._resetIdleTimer(session);
  }

  popNotifications() {
    const logs = [...this.pendingNotifications];
    this.pendingNotifications = [];
    return logs;
  }

  write(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    try {
      logger.debug(`Writing to session ${sessionId}: ${data.slice(0, 50)}${data.length > 50 ? '...' : ''}`);
      session.pty.write(data);
    } catch (error) {
      this.sessions.delete(sessionId);
      throw new Error(`Failed to write to session ${sessionId}: ${error.message}`);
    }
  }

  read(sessionId, clear = false) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const result = {
      text: session.cleanBuffer,
      raw: session.buffer
    };
    if (clear) {
      logger.debug(`Clearing buffer for session ${sessionId}`);
      session.cleanBuffer = '';
      session.buffer = '';
    }
    return result;
  }

  destroy(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      logger.debug(`Destroying session ${sessionId}`);
      try {
        session.pty.kill();
      } catch (e) {}
      if (session.idleTimer) clearTimeout(session.idleTimer);
      this.sessions.delete(sessionId);
    }
  }
}

export default new TerminalManager();
