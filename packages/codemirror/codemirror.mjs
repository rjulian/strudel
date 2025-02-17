import { closeBrackets } from '@codemirror/autocomplete';
// import { search, highlightSelectionMatches } from '@codemirror/search';
import { history } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLineGutter,
  highlightActiveLine,
  keymap,
  lineNumbers,
  drawSelection,
} from '@codemirror/view';
import { Pattern, Drawer, repl, cleanupDraw } from '@strudel.cycles/core';
import { isAutoCompletionEnabled } from './autocomplete.mjs';
import { isTooltipEnabled } from './tooltip.mjs';
import { flash, isFlashEnabled } from './flash.mjs';
import { highlightMiniLocations, isPatternHighlightingEnabled, updateMiniLocations } from './highlight.mjs';
import { keybindings } from './keybindings.mjs';
import { initTheme, activateTheme, theme } from './themes.mjs';
import { updateWidgets, sliderPlugin } from './slider.mjs';
import { persistentAtom } from '@nanostores/persistent';

const extensions = {
  isLineWrappingEnabled: (on) => (on ? EditorView.lineWrapping : []),
  isLineNumbersDisplayed: (on) => (on ? lineNumbers() : []),
  theme,
  isAutoCompletionEnabled,
  isTooltipEnabled,
  isPatternHighlightingEnabled,
  isActiveLineHighlighted: (on) => (on ? [highlightActiveLine(), highlightActiveLineGutter()] : []),
  isFlashEnabled,
  keybindings,
};
const compartments = Object.fromEntries(Object.keys(extensions).map((key) => [key, new Compartment()]));

export const defaultSettings = {
  keybindings: 'codemirror',
  isLineNumbersDisplayed: true,
  isActiveLineHighlighted: false,
  isAutoCompletionEnabled: false,
  isPatternHighlightingEnabled: true,
  isFlashEnabled: true,
  isTooltipEnabled: false,
  isLineWrappingEnabled: false,
  theme: 'strudelTheme',
  fontFamily: 'monospace',
  fontSize: 18,
};

export const codemirrorSettings = persistentAtom('codemirror-settings', defaultSettings, {
  encode: JSON.stringify,
  decode: JSON.parse,
});

// https://codemirror.net/docs/guide/
export function initEditor({ initialCode = '', onChange, onEvaluate, onStop, root }) {
  const settings = codemirrorSettings.get();
  const initialSettings = Object.keys(compartments).map((key) =>
    compartments[key].of(extensions[key](parseBooleans(settings[key]))),
  );
  initTheme(settings.theme);
  let state = EditorState.create({
    doc: initialCode,
    extensions: [
      /* search(),
      highlightSelectionMatches(), */
      ...initialSettings,
      javascript(),
      sliderPlugin,
      // indentOnInput(), // works without. already brought with javascript extension?
      // bracketMatching(), // does not do anything
      closeBrackets(),
      syntaxHighlighting(defaultHighlightStyle),
      history(),
      EditorView.updateListener.of((v) => onChange(v)),
      drawSelection({ cursorBlinkRate: 0 }),
      Prec.highest(
        keymap.of([
          {
            key: 'Ctrl-Enter',
            run: () => onEvaluate?.(),
          },
          {
            key: 'Alt-Enter',
            run: () => onEvaluate?.(),
          },
          {
            key: 'Ctrl-.',
            run: () => onStop?.(),
          },
          {
            key: 'Alt-.',
            run: (_, e) => {
              e.preventDefault();
              onStop?.();
            },
          },
          /* {
          key: 'Ctrl-Shift-.',
          run: () => (onPanic ? onPanic() : onStop?.()),
        },
        {
          key: 'Ctrl-Shift-Enter',
          run: () => (onReEvaluate ? onReEvaluate() : onEvaluate?.()),
        }, */
        ]),
      ),
    ],
  });

  return new EditorView({
    state,
    parent: root,
  });
}

export class StrudelMirror {
  constructor(options) {
    const {
      root,
      id,
      initialCode = '',
      onDraw,
      drawTime = [0, 0],
      autodraw,
      prebake,
      bgFill = true,
      ...replOptions
    } = options;
    this.code = initialCode;
    this.root = root;
    this.miniLocations = [];
    this.widgets = [];
    this.painters = [];
    this.drawTime = drawTime;
    this.onDraw = onDraw;
    const self = this;
    this.id = id || s4();

    this.drawer = new Drawer((haps, time) => {
      const currentFrame = haps.filter((hap) => time >= hap.whole.begin && time <= hap.endClipped);
      this.highlight(currentFrame, time);
      this.onDraw?.(haps, time, currentFrame, this.painters);
    }, drawTime);

    // this approach does not work with multiple repls on screen
    // TODO: refactor onPaint usages + find fix, maybe remove painters here?
    Pattern.prototype.onPaint = function (onPaint) {
      self.painters.push(onPaint);
      return this;
    };

    this.prebaked = prebake();
    autodraw && this.drawFirstFrame();

    this.repl = repl({
      ...replOptions,
      onToggle: (started) => {
        replOptions?.onToggle?.(started);
        if (started) {
          this.adjustDrawTime();
          this.drawer.start(this.repl.scheduler);
          // stop other repls when this one is started
          document.dispatchEvent(
            new CustomEvent('start-repl', {
              detail: this.id,
            }),
          );
        } else {
          this.drawer.stop();
          updateMiniLocations(this.editor, []);
          cleanupDraw(false);
        }
      },
      beforeEval: async () => {
        cleanupDraw();
        this.painters = [];
        await this.prebaked;
        await replOptions?.beforeEval?.();
      },
      afterEval: (options) => {
        // remember for when highlighting is toggled on
        this.miniLocations = options.meta?.miniLocations;
        this.widgets = options.meta?.widgets;
        updateWidgets(this.editor, this.widgets);
        updateMiniLocations(this.editor, this.miniLocations);
        replOptions?.afterEval?.(options);
        this.adjustDrawTime();
        this.drawer.invalidate();
      },
    });
    this.editor = initEditor({
      root,
      initialCode,
      onChange: (v) => {
        if (v.docChanged) {
          this.code = v.state.doc.toString();
          this.repl.setCode?.(this.code);
        }
      },
      onEvaluate: () => this.evaluate(),
      onStop: () => this.stop(),
    });
    const cmEditor = this.root.querySelector('.cm-editor');
    if (cmEditor) {
      this.root.style.display = 'block';
      if (bgFill) {
        this.root.style.backgroundColor = 'var(--background)';
      }
      cmEditor.style.backgroundColor = 'transparent';
    }
    const settings = codemirrorSettings.get();
    this.setFontSize(settings.fontSize);
    this.setFontFamily(settings.fontFamily);

    // stop this repl when another repl is started
    this.onStartRepl = (e) => {
      if (e.detail !== this.id) {
        this.stop();
      }
    };
    document.addEventListener('start-repl', this.onStartRepl);
  }
  // adjusts draw time depending on if there are painters
  adjustDrawTime() {
    // when no painters are set, [0,0] is enough (just highlighting)
    this.drawer.setDrawTime(this.painters.length ? this.drawTime : [0, 0]);
  }
  async drawFirstFrame() {
    if (!this.onDraw) {
      return;
    }
    // draw first frame instantly
    await this.prebaked;
    try {
      await this.repl.evaluate(this.code, false);
      this.drawer.invalidate(this.repl.scheduler, -0.001);
      // draw at -0.001 to avoid haps at 0 to be visualized as active
      this.onDraw?.(this.drawer.visibleHaps, -0.001, [], this.painters);
    } catch (err) {
      console.warn('first frame could not be painted');
    }
  }
  async evaluate() {
    this.flash();
    await this.repl.evaluate(this.code);
  }
  async stop() {
    this.repl.scheduler.stop();
  }
  async toggle() {
    if (this.repl.scheduler.started) {
      this.repl.stop();
    } else {
      this.evaluate();
    }
  }
  flash(ms) {
    flash(this.editor, ms);
  }
  highlight(haps, time) {
    highlightMiniLocations(this.editor, time, haps);
  }
  setFontSize(size) {
    this.root.style.fontSize = size + 'px';
  }
  setFontFamily(family) {
    this.root.style.fontFamily = family;
    const scroller = this.root.querySelector('.cm-scroller');
    if (scroller) {
      scroller.style.fontFamily = family;
    }
  }
  reconfigureExtension(key, value) {
    if (!extensions[key]) {
      console.warn(`extension ${key} is not known`);
      return;
    }
    value = parseBooleans(value);
    const newValue = extensions[key](value, this);
    this.editor.dispatch({
      effects: compartments[key].reconfigure(newValue),
    });
    if (key === 'theme') {
      activateTheme(value);
    }
  }
  setLineWrappingEnabled(enabled) {
    this.reconfigureExtension('isLineWrappingEnabled', enabled);
  }
  setLineNumbersDisplayed(enabled) {
    this.reconfigureExtension('isLineNumbersDisplayed', enabled);
  }
  setTheme(theme) {
    this.reconfigureExtension('theme', theme);
  }
  setAutocompletionEnabled(enabled) {
    this.reconfigureExtension('isAutoCompletionEnabled', enabled);
  }
  updateSettings(settings) {
    this.setFontSize(settings.fontSize);
    this.setFontFamily(settings.fontFamily);
    for (let key in extensions) {
      this.reconfigureExtension(key, settings[key]);
    }
    const updated = { ...codemirrorSettings.get(), ...settings };
    codemirrorSettings.set(updated);
  }
  changeSetting(key, value) {
    if (extensions[key]) {
      this.reconfigureExtension(key, value);
      return;
    } else if (key === 'fontFamily') {
      this.setFontFamily(value);
    } else if (key === 'fontSize') {
      this.setFontSize(value);
    }
  }
  setCode(code) {
    const changes = { from: 0, to: this.editor.state.doc.length, insert: code };
    this.editor.dispatch({ changes });
  }
  clear() {
    this.onStartRepl && document.removeEventListener('start-repl', this.onStartRepl);
  }
}

function parseBooleans(value) {
  return { true: true, false: false }[value] ?? value;
}

// helper function to generate repl ids
function s4() {
  return Math.floor((1 + Math.random()) * 0x10000)
    .toString(16)
    .substring(1);
}
