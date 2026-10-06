const fs = require('fs');
const path = require('path');

let code = fs.readFileSync(path.join(__dirname, 'node_modules/thinking-orbs/dist/index-B8WsUNf5.js'), 'utf8');
code = code.replace(/export\s*\{[\s\S]*?\};?/, '');

const classCode = `
class ThinkingOrb {
  constructor(canvas, options = {}) {
    this.canvas = typeof canvas === 'string' ? document.querySelector(canvas) : canvas;
    this.state = options.state || 'working';
    this.size = options.size || 64;
    this.speed = options.speed || 1;
    this.dark = options.dark || false;
    this.color = options.color || null;
    this.paused = options.paused || false;
    this.running = false;
    this.raf = null;
    this.init();
  }

  parseTint(color) {
    if (!color) return undefined;
    const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      let h2 = hex[1];
      if (h2.length === 3) h2 = h2.replace(/./g, (c) => c + c);
      const n = parseInt(h2, 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    const fn = color.trim().match(/^rgba?\\s*\\(\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)/i);
    if (fn) return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]) };
    return undefined;
  }

  init() {
    if (!this.canvas) return;
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    this.canvas.width = Math.round(this.size * dpr);
    this.canvas.height = Math.round(this.size * dpr);
    this.canvas.style.width = this.size + 'px';
    this.canvas.style.height = this.size + 'px';
    this.ctx = this.canvas.getContext('2d');
    this.dpr = dpr;
    this.start();
  }

  render(tSec) {
    if (!this.ctx) return;
    const presetSize = this.size <= 26 ? 20 : (this.size <= 48 ? 32 : 64);
    const preset = resolvePreset(this.state, presetSize);
    if (!preset) return;
    const { mode, opts } = preset;
    const frameFn = MODE_FRAMES[mode];
    if (!frameFn) return;
    const tint = this.parseTint(this.color);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.clearRect(0, 0, this.size, this.size);
    // Draw using presetSize coordinates, scaled to actual size
    const scaleFactor = this.size / presetSize;
    if (scaleFactor !== 1) {
      this.ctx.save();
      this.ctx.scale(scaleFactor, scaleFactor);
      const frame = frameFn(presetSize, tSec, opts);
      paintFrame(this.ctx, frame, this.dark, tint);
      this.ctx.restore();
    } else {
      const frame = frameFn(this.size, tSec, opts);
      paintFrame(this.ctx, frame, this.dark, tint);
    }
  }

  start() {
    if (this.running || this.paused) return;
    this.running = true;
    const loop = () => {
      const presetSize = this.size <= 26 ? 20 : (this.size <= 48 ? 32 : 64);
      const preset = resolvePreset(this.state, presetSize);
      const baseSpeed = preset ? preset.speed : 1;
      const effSpeed = baseSpeed * this.speed;
      this.render((performance.now() / 1000) * effSpeed);
      if (this.running) {
        this.raf = requestAnimationFrame(loop);
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  setState(newState) {
    if (this.state !== newState) {
      this.state = newState;
    }
  }

  setColor(newColor) {
    this.color = newColor;
  }

  setSize(newSize) {
    this.size = newSize;
    if (this.canvas) {
      const dpr = this.dpr || 1;
      this.canvas.width = Math.round(this.size * dpr);
      this.canvas.height = Math.round(this.size * dpr);
      this.canvas.style.width = this.size + 'px';
      this.canvas.style.height = this.size + 'px';
    }
  }

  destroy() {
    this.stop();
  }
}
`;

const wrapper = `(function(window) {
'use strict';

${code}

${classCode}

window.ThinkingOrb = ThinkingOrb;
window.ThinkingOrbEngine = {
  MODE_FRAMES,
  STATE_TO_MODE,
  resolvePreset,
  paintFrame
};

})(typeof window !== 'undefined' ? window : global);
`;

fs.writeFileSync(path.join(__dirname, 'public/thinking-orbs.js'), wrapper, 'utf8');
console.log('Successfully wrote public/thinking-orbs.js');
