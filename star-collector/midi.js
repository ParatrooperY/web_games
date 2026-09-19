// 极简标准 MIDI 文件解析器：提取各轨音符事件（音高/秒级时间/时长/力度）
// 浏览器挂在 window.MidiParse，Node 下可 require 用于测试
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MidiParse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function readVlq(bytes, pos) {
    let v = 0, b;
    do { b = bytes[pos++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80);
    return [v, pos];
  }

  // 返回 { division, tracks: [{ name, notes: [{ pitch, time, dur, vel }] }] }，time/dur 单位为秒
  function parse(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    if (view.getUint32(0) !== 0x4d546864) throw new Error('不是 MIDI 文件');
    const format = view.getUint16(8);
    const ntrks = view.getUint16(10);
    const division = view.getUint16(12);
    if (division & 0x8000) throw new Error('不支持 SMPTE 时间格式');
    const tpq = division;

    let pos = 8 + view.getUint32(4);
    const rawTracks = [];
    const tempos = [{ tick: 0, usPerQuarter: 500000 }]; // 默认 120bpm

    for (let t = 0; t < ntrks; t++) {
      if (view.getUint32(pos) !== 0x4d54726b) throw new Error('轨道块损坏');
      const len = view.getUint32(pos + 4);
      const end = pos + 8 + len;
      let p = pos + 8;
      let tick = 0;
      let status = 0;
      let name = '';
      const open = {};   // pitch -> [{ tick, vel }]
      const notes = [];  // tick 制，稍后统一换算

      while (p < end) {
        const dt = readVlq(bytes, p); tick += dt[0]; p = dt[1];
        let b = bytes[p];
        if (b < 0x80) { b = status; } else { p++; if (b < 0xf0) status = b; }

        if (b === 0xff) {
          const type = bytes[p++];
          const l = readVlq(bytes, p); p = l[1];
          if (type === 0x51) tempos.push({ tick, usPerQuarter: (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2] });
          if (type === 0x03 && !name) name = new TextDecoder().decode(bytes.subarray(p, p + l[0]));
          p += l[0];
        } else if (b === 0xf0 || b === 0xf7) {
          const l = readVlq(bytes, p); p = l[1] + l[0];
        } else {
          const kind = b & 0xf0;
          const d1 = bytes[p++];
          if (kind === 0x90 && d1 !== undefined) {
            const vel = bytes[p++];
            if (vel > 0) (open[d1] = open[d1] || []).push({ tick, vel });
            else closeNote(open, notes, d1, tick);
          } else if (kind === 0x80) {
            p++; closeNote(open, notes, d1, tick);
          } else if (kind === 0xc0 || kind === 0xd0) {
            // 单数据字节，已读
          } else {
            p++; // 其余双数据字节事件
          }
        }
      }
      rawTracks.push({ name, notes });
      pos = end;
    }

    // tick → 秒：按全局速度表累计
    tempos.sort((a, b) => a.tick - b.tick);
    function toSec(targetTick) {
      let sec = 0, lastTick = 0, us = tempos[0].usPerQuarter;
      for (const tp of tempos) {
        if (tp.tick > targetTick) break;
        sec += ((tp.tick - lastTick) / tpq) * (us / 1e6);
        lastTick = tp.tick;
        us = tp.usPerQuarter;
      }
      return sec + ((targetTick - lastTick) / tpq) * (us / 1e6);
    }

    const tracks = rawTracks.map((tr) => ({
      name: tr.name,
      notes: tr.notes
        .map((n) => ({ pitch: n.pitch, vel: n.vel, time: toSec(n.tick), dur: Math.max(0.05, toSec(n.endTick) - toSec(n.tick)) }))
        .sort((a, b) => a.time - b.time),
    }));

    // 速度表换算成秒级时间点 + bpm，供展示用
    const tempoList = tempos.map((t) => ({ time: toSec(t.tick), bpm: Math.round(60000000 / t.usPerQuarter) }));

    return { format, division: tpq, tempos: tempoList, tracks };
  }

  function closeNote(open, notes, pitch, tick) {
    const list = open[pitch];
    if (list && list.length) {
      const n = list.shift();
      notes.push({ pitch, vel: n.vel, tick: n.tick, endTick: tick });
    }
  }

  return { parse };
});
