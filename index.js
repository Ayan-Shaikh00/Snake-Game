/**
 * Snake — vanilla JavaScript implementation.
 *
 * Structure:
 *  - CONFIG / constants   : tunable game settings
 *  - ScoreStore           : localStorage persistence (high score + recent runs)
 *  - Renderer             : canvas drawing (grid, snake, food, decorative wave)
 *  - Game                 : state, rules and the main loop
 *  - Input                : keyboard + swipe handling
 *  - UI                   : DOM updates (stats, overlay)
 */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Config
   * ------------------------------------------------------------------ */
  const CONFIG = Object.freeze({
    cols: 40, // keep in sync with .board aspect-ratio in styles.css
    rows: 22,
    startLength: 3,
    baseTickMs: 120, // time between moves at the start
    minTickMs: 55, // fastest allowed speed
    speedStepMs: 3, // speed-up per food eaten
    maxDtMs: 250, // clamp for background-tab frame gaps
    storageKey: 'snake:v1',
    historyLimit: 8,
    swipeThreshold: 24,
  });

  const COLORS = Object.freeze({
    background: '#0f0f10',
    grid: 'rgba(255, 255, 255, 0.16)',
    snake: '#dcdcdc',
    food: '#ff7b8a',
    waveFill: 'rgba(255, 255, 255, 0.14)',
    waveStroke: 'rgba(255, 255, 255, 0.4)',
  });

  const DIRECTIONS = Object.freeze({
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  });

  const OPPOSITE = Object.freeze({ up: 'down', down: 'up', left: 'right', right: 'left' });

  const KEY_TO_DIRECTION = Object.freeze({
    ArrowUp: 'up', w: 'up', W: 'up',
    ArrowDown: 'down', s: 'down', S: 'down',
    ArrowLeft: 'left', a: 'left', A: 'left',
    ArrowRight: 'right', d: 'right', D: 'right',
  });

  const Status = Object.freeze({ IDLE: 'idle', RUNNING: 'running', PAUSED: 'paused', OVER: 'over' });

  /* ------------------------------------------------------------------ *
   * Score persistence
   * ------------------------------------------------------------------ */
  const ScoreStore = {
    load() {
      const fallback = { highScore: 0, history: [] };
      try {
        const raw = window.localStorage.getItem(CONFIG.storageKey);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        const highScore = Number.isFinite(parsed?.highScore) ? Math.max(0, parsed.highScore) : 0;
        const history = Array.isArray(parsed?.history)
          ? parsed.history.filter(Number.isFinite).slice(0, CONFIG.historyLimit)
          : [];
        return { highScore, history };
      } catch {
        return fallback; // storage unavailable or corrupted
      }
    },

    save(data) {
      try {
        window.localStorage.setItem(CONFIG.storageKey, JSON.stringify(data));
      } catch {
        /* ignore quota / privacy-mode errors */
      }
    },

    /** Records a finished run and returns the updated data. */
    record(score) {
      const data = this.load();
      data.highScore = Math.max(data.highScore, score);
      data.history = [score, ...data.history].slice(0, CONFIG.historyLimit);
      this.save(data);
      return data;
    },
  };

  /* ------------------------------------------------------------------ *
   * UI (DOM access lives here only)
   * ------------------------------------------------------------------ */
  const UI = {
    el: {
      board: document.getElementById('board'),
      score: document.getElementById('score'),
      highScore: document.getElementById('high-score'),
      timer: document.getElementById('timer'),
      overlay: document.getElementById('overlay'),
      title: document.getElementById('overlay-title'),
      text: document.getElementById('overlay-text'),
      history: document.getElementById('overlay-history'),
      button: document.getElementById('action-btn'),
    },

    setScore(value) {
      this.el.score.textContent = value;
    },

    setHighScore(value) {
      this.el.highScore.textContent = value;
    },

    setTimer(totalSeconds) {
      const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
      const ss = String(totalSeconds % 60).padStart(2, '0');
      this.el.timer.textContent = `${mm}-${ss}`;
    },

    showOverlay({ title, text, button, history = [] }) {
      this.el.title.textContent = title;
      this.el.text.textContent = text;
      this.el.button.textContent = button;

      this.el.history.replaceChildren(
        ...history.map((value) => {
          const li = document.createElement('li');
          li.textContent = value;
          return li;
        })
      );
      this.el.history.hidden = history.length === 0;

      this.el.overlay.classList.remove('is-hidden');
      this.el.button.focus({ preventScroll: true });
    },

    hideOverlay() {
      this.el.overlay.classList.add('is-hidden');
      this.el.button.blur();
    },
  };

  /* ------------------------------------------------------------------ *
   * Renderer
   * ------------------------------------------------------------------ */
  class Renderer {
    constructor(gameCanvas, waveCanvas) {
      this.canvas = gameCanvas;
      this.ctx = gameCanvas.getContext('2d');
      this.waveCanvas = waveCanvas;
      this.waveCtx = waveCanvas.getContext('2d');
      this.cellW = 0;
      this.cellH = 0;
      this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      this.resize = this.resize.bind(this);
      new ResizeObserver(this.resize).observe(gameCanvas.parentElement);
      this.resize();
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const { clientWidth: w, clientHeight: h } = this.canvas;
      if (!w || !h) return;

      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.waveCanvas.width = Math.round(this.waveCanvas.clientWidth * dpr);
      this.waveCanvas.height = Math.round(this.waveCanvas.clientHeight * dpr);

      this.cellW = this.canvas.width / CONFIG.cols;
      this.cellH = this.canvas.height / CONFIG.rows;
      this.dpr = dpr;
      this.needsRedraw = true;
    }

    draw(state) {
      const { ctx, cellW, cellH } = this;
      ctx.fillStyle = COLORS.background;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

      this.#drawGrid();

      // Food
      if (state.food) this.#drawCell(state.food, COLORS.food);

      // Snake
      for (const segment of state.snake) this.#drawCell(segment, COLORS.snake);
    }

    #drawGrid() {
      const { ctx, cellW, cellH } = this;
      const { width, height } = this.canvas;

      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = Math.max(1, Math.round(this.dpr * 0.5));
      ctx.beginPath();
      for (let c = 1; c < CONFIG.cols; c++) {
        const x = Math.round(c * cellW) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let r = 1; r < CONFIG.rows; r++) {
        const y = Math.round(r * cellH) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();
    }

    #drawCell({ x, y }, color) {
      const inset = Math.max(1, Math.round(this.dpr * 1.5));
      this.ctx.fillStyle = color;
      this.ctx.fillRect(
        Math.round(x * this.cellW) + inset,
        Math.round(y * this.cellH) + inset,
        Math.round(this.cellW) - inset * 2,
        Math.round(this.cellH) - inset * 2
      );
    }

    /** Decorative audio-style waveform along the bottom of the board. */
    drawWave(timeMs) {
      const { waveCtx: ctx, waveCanvas: canvas } = this;
      const { width, height } = canvas;
      if (!width || !height) return;

      const t = this.reducedMotion ? 0 : timeMs / 1000;
      ctx.clearRect(0, 0, width, height);

      ctx.beginPath();
      ctx.moveTo(0, height);
      const step = Math.max(4, Math.round(width / 220));
      for (let x = 0; x <= width; x += step) {
        const n = x / width;
        const amp =
          Math.sin(n * 22 + t * 1.6) * 0.35 +
          Math.sin(n * 47 - t * 2.3) * 0.25 +
          Math.sin(n * 9 + t * 0.8) * 0.4;
        const envelope = 0.45 + 0.55 * Math.abs(Math.sin(n * 5 + 1));
        const y = height - (0.22 + 0.5 * Math.abs(amp) * envelope) * height;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, height);
      ctx.closePath();

      ctx.fillStyle = COLORS.waveFill;
      ctx.fill();
      ctx.strokeStyle = COLORS.waveStroke;
      ctx.lineWidth = Math.max(1, this.dpr);
      ctx.stroke();
    }
  }

  /* ------------------------------------------------------------------ *
   * Game
   * ------------------------------------------------------------------ */
  class Game {
    constructor(renderer) {
      this.renderer = renderer;
      this.store = ScoreStore.load();
      this.status = Status.IDLE;
      this.#reset();

      UI.setHighScore(this.store.highScore);
      UI.showOverlay({
        title: 'Snake',
        text: 'Use arrow keys or WASD to move. Eat the pink food, avoid walls and yourself.',
        button: 'Start',
        history: this.store.history,
      });

      this.loop = this.loop.bind(this);
      requestAnimationFrame(this.loop);
    }

    /* ---- state ---- */

    #reset() {
      const midY = Math.floor(CONFIG.rows / 2);
      const startX = Math.floor(CONFIG.cols / 2);
      this.snake = Array.from({ length: CONFIG.startLength }, (_, i) => ({ x: startX - i, y: midY }));
      this.direction = 'right';
      this.inputQueue = [];
      this.score = 0;
      this.elapsedMs = 0;
      this.accumulator = 0;
      this.tickMs = CONFIG.baseTickMs;
      this.lastSecond = -1;
      this.food = this.#randomFreeCell();

      UI.setScore(0);
      UI.setTimer(0);
    }

    #randomFreeCell() {
      const occupied = new Set(this.snake.map(({ x, y }) => `${x},${y}`));
      const free = [];
      for (let y = 0; y < CONFIG.rows; y++) {
        for (let x = 0; x < CONFIG.cols; x++) {
          if (!occupied.has(`${x},${y}`)) free.push({ x, y });
        }
      }
      return free.length ? free[Math.floor(Math.random() * free.length)] : null;
    }

    /* ---- controls ---- */

    start() {
      if (this.status === Status.OVER || this.status === Status.IDLE) this.#reset();
      this.status = Status.RUNNING;
      this.lastFrame = performance.now();
      UI.hideOverlay();
    }

    pause() {
      if (this.status !== Status.RUNNING) return;
      this.status = Status.PAUSED;
      UI.showOverlay({ title: 'Paused', text: 'Press Space to resume.', button: 'Resume' });
    }

    toggle() {
      if (this.status === Status.RUNNING) this.pause();
      else this.start();
    }

    queueDirection(next) {
      if (this.status !== Status.RUNNING) return;
      // Compare against the last queued direction so quick double-taps can't reverse the snake.
      const reference = this.inputQueue.length
        ? this.inputQueue[this.inputQueue.length - 1]
        : this.direction;
      if (next === reference || next === OPPOSITE[reference]) return;
      if (this.inputQueue.length < 2) this.inputQueue.push(next);
    }

    /* ---- rules ---- */

    #step() {
      if (this.inputQueue.length) this.direction = this.inputQueue.shift();
      const delta = DIRECTIONS[this.direction];
      const head = this.snake[0];
      const next = { x: head.x + delta.x, y: head.y + delta.y };

      const hitsWall = next.x < 0 || next.y < 0 || next.x >= CONFIG.cols || next.y >= CONFIG.rows;
      if (hitsWall) return this.#gameOver('You hit the wall.');

      const eats = this.food && next.x === this.food.x && next.y === this.food.y;

      // When not growing, the tail cell is vacated this tick, so it is safe to enter.
      const body = eats ? this.snake : this.snake.slice(0, -1);
      if (body.some((s) => s.x === next.x && s.y === next.y)) {
        return this.#gameOver('You ran into yourself.');
      }

      this.snake.unshift(next);

      if (eats) {
        this.score += 1;
        this.tickMs = Math.max(CONFIG.minTickMs, this.tickMs - CONFIG.speedStepMs);
        UI.setScore(this.score);
        this.food = this.#randomFreeCell();
        if (!this.food) return this.#gameOver('You filled the board — perfect game!');
      } else {
        this.snake.pop();
      }
    }

    #gameOver(reason) {
      this.status = Status.OVER;
      this.store = ScoreStore.record(this.score);
      UI.setHighScore(this.store.highScore);
      UI.showOverlay({
        title: 'Game Over',
        text: `${reason} Score: ${this.score}`,
        button: 'Play again',
        history: this.store.history,
      });
    }

    /* ---- main loop ---- */

    loop(now) {
      if (this.status === Status.RUNNING) {
        const dt = Math.min(now - this.lastFrame, CONFIG.maxDtMs);
        this.lastFrame = now;
        this.accumulator += dt;
        this.elapsedMs += dt;

        while (this.accumulator >= this.tickMs && this.status === Status.RUNNING) {
          this.accumulator -= this.tickMs;
          this.#step();
        }

        const seconds = Math.floor(this.elapsedMs / 1000);
        if (seconds !== this.lastSecond) {
          this.lastSecond = seconds;
          UI.setTimer(seconds);
        }
      }

      this.renderer.draw({ snake: this.snake, food: this.food });
      this.renderer.drawWave(now);
      requestAnimationFrame(this.loop);
    }
  }

  /* ------------------------------------------------------------------ *
   * Input
   * ------------------------------------------------------------------ */
  function bindInput(game) {
    window.addEventListener('keydown', (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const direction = KEY_TO_DIRECTION[event.key];
      if (direction) {
        event.preventDefault();
        if (game.status === Status.IDLE || game.status === Status.OVER) game.start();
        game.queueDirection(direction);
        return;
      }

      if (event.key === ' ' || event.key === 'Spacebar' || event.key === 'Enter') {
        // Let Enter/Space on the focused button work natively once.
        if (event.target === UI.el.button) return;
        event.preventDefault();
        game.toggle();
      }
    });

    UI.el.button.addEventListener('click', () => game.start());

    // Swipe controls
    let touchStart = null;
    UI.el.board.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      touchStart = { x: e.clientX, y: e.clientY };
    });
    UI.el.board.addEventListener('pointerup', (e) => {
      if (!touchStart) return;
      const dx = e.clientX - touchStart.x;
      const dy = e.clientY - touchStart.y;
      touchStart = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < CONFIG.swipeThreshold) return;
      game.queueDirection(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
    });

    // Auto-pause when the tab is hidden
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) game.pause();
    });
  }

  /* ------------------------------------------------------------------ *
   * Bootstrap
   * ------------------------------------------------------------------ */
  const renderer = new Renderer(document.getElementById('game'), document.getElementById('wave'));
  bindInput(new Game(renderer));
})();