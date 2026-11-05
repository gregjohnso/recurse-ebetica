// The composer's model menu lists every offered model and the chosen model's
// thinking levels. models.ts owns the conversation state and saving.
import { CHECK_ICON } from "../icons.js";
import {
  THINKING_ORDER,
  clampReasoning,
  contextLabel,
  indexModels,
  reasoningChoices,
  searchModels,
  type FinderModel,
  type IndexedModel,
} from "./finder.js";

export interface PickerView {
  /** Offered models in server route order; null while the list loads. */
  models: readonly FinderModel[] | null;
  /** Every level, for models whose own levels are unknown. */
  levels: readonly string[];
  model: string | null;
  effort: string | null;
  disabled: boolean;
}

export interface ModelPicker {
  element: HTMLElement;
  paint(view: PickerView): void;
}

/** Build the picker; `onPick` receives a model and a level it supports. */
export function createModelPicker(
  onPick: (model: string, effort: string) => void,
): ModelPicker {
  const element = document.createElement("div");
  element.className = "model-picker";
  const filter = document.createElement("input");
  filter.type = "search";
  filter.className = "text-field model-picker-filter";
  filter.placeholder = "Filter models";
  filter.setAttribute("aria-label", "Filter models");
  const list = document.createElement("div");
  list.className = "model-picker-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Models");
  const thinkingLabel = document.createElement("p");
  thinkingLabel.className = "model-picker-heading";
  thinkingLabel.textContent = "Thinking";
  const thinking = document.createElement("div");
  thinking.className = "model-picker-thinking";
  thinking.setAttribute("role", "radiogroup");
  thinking.setAttribute("aria-label", "Thinking level");
  element.append(filter, list, thinkingLabel, thinking);

  let view: PickerView = {
    models: null,
    levels: THINKING_ORDER,
    model: null,
    effort: null,
    disabled: false,
  };
  let indexed: {
    models: readonly FinderModel[];
    index: IndexedModel[];
  } | null = null;
  const choicesFor = (id: string | null) =>
    reasoningChoices(
      view.models?.find((m) => m.id === id)?.reasoning_levels,
      view.levels,
    );

  const paintList = () => {
    list.textContent = "";
    if (!view.models) {
      list.textContent = "Loading models…";
      return;
    }
    if (indexed?.models !== view.models)
      indexed = { models: view.models, index: indexModels(view.models) };
    const query = filter.value.trim();
    const shown = query
      ? searchModels(indexed.index, query, view.models.length).models
      : view.models;
    if (!shown.length)
      list.textContent = view.models.length
        ? "No matching models"
        : "No models available. Sign in from Settings.";
    let route = "";
    for (const model of shown) {
      if (!query && model.route !== route) {
        route = model.route;
        const heading = document.createElement("p");
        heading.className = "model-picker-route";
        heading.textContent = route;
        list.append(heading);
      }
      const option = document.createElement("button");
      option.type = "button";
      option.className = "model-picker-option";
      option.dataset.model = model.id;
      option.setAttribute("role", "option");
      const selected = model.id === view.model;
      option.setAttribute("aria-selected", String(selected));
      option.disabled = view.disabled;
      option.title = model.id;
      const check = document.createElement("span");
      check.className = "model-picker-check";
      if (selected) check.innerHTML = CHECK_ICON;
      const name = document.createElement("span");
      name.className = "model-picker-name";
      name.textContent = model.label || model.id;
      const context = document.createElement("span");
      context.className = "model-picker-context";
      context.textContent = contextLabel(model.context_window);
      option.append(check, name, context);
      option.addEventListener("click", () => {
        if (view.disabled || model.id === view.model) return;
        onPick(
          model.id,
          clampReasoning(
            reasoningChoices(model.reasoning_levels, view.levels),
            view.effort ?? "medium",
          ),
        );
      });
      list.append(option);
    }
  };

  const paintThinking = () => {
    thinking.textContent = "";
    const model = view.model;
    for (const level of choicesFor(model)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "model-picker-level";
      button.dataset.level = level;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(level === view.effort));
      button.disabled = view.disabled || !model;
      button.textContent = level;
      button.addEventListener("click", () => {
        if (!view.disabled && model && level !== view.effort)
          onPick(model, level);
      });
      thinking.append(button);
    }
  };

  // Invariant: The open menu turns j/k and arrow keys into slider steps; keys
  // typed into the filter stay in the filter. Escape still closes the menu.
  filter.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") event.stopPropagation();
  });
  filter.addEventListener("input", paintList);

  return {
    element,
    paint(next) {
      // Invariant: Polls repaint often; an unchanged view keeps the list's
      // scroll position and focus, and a changed one restores its scroll.
      if (
        next.models === view.models &&
        next.levels === view.levels &&
        next.model === view.model &&
        next.effort === view.effort &&
        next.disabled === view.disabled &&
        list.childElementCount
      )
        return;
      const moved = next.model !== view.model || next.models !== view.models;
      view = next;
      filter.disabled = !next.models;
      const scroll = list.scrollTop;
      paintList();
      list.scrollTop = scroll;
      if (moved)
        list
          .querySelector('[aria-selected="true"]')
          ?.scrollIntoView({ block: "nearest" });
      paintThinking();
    },
  };
}
