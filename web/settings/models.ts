// Model settings keep prompt caching, context limits and which models
// the composer's model menu lists on the selected backend.
import { settingsClient } from "./target.js";
import { settingsDetail } from "./layout.js";
import {
  modelListStatusText,
  type ModelListUpdateStatus,
} from "../models/list-status.js";
import {
  indexModels,
  searchModels,
  type FinderModel,
} from "../models/finder.js";

async function errDetail(r: Response, fallback: string): Promise<string> {
  try {
    return ((await r.json()) as { detail?: string }).detail || fallback;
  } catch {
    return fallback;
  }
}

export function buildPromptCacheSection(body: HTMLElement): void {
  const { api, jpost } = settingsClient();
  body.innerHTML = `
    <div class="group"><label class="item check"><span>Keep prompt cache warm while agents work</span>
      <input type="checkbox" class="switch" role="switch" disabled></label></div>
    <p class="msg"></p>`;
  const box = body.querySelector<HTMLInputElement>("input")!;
  const msg = body.querySelector<HTMLElement>(".msg")!;
  api("/api/settings/prompt-cache-warming")
    .then(async (r) => {
      if (!r.ok) throw new Error(await errDetail(r, "Couldn't load."));
      box.checked = (await r.json()).enabled;
      box.disabled = false;
    })
    .catch(() => {
      msg.textContent = "Couldn't load.";
      msg.className = "msg err";
    });
  box.addEventListener("change", async () => {
    box.disabled = true;
    try {
      const r = await jpost("/api/settings/prompt-cache-warming", {
        enabled: box.checked,
      });
      if (!r.ok) throw new Error(await errDetail(r, "Couldn't save."));
      box.checked = (await r.json()).enabled;
      msg.textContent = "";
    } catch (error) {
      box.checked = !box.checked;
      msg.textContent =
        error instanceof Error ? error.message : "Couldn't save.";
      msg.className = "msg err";
    } finally {
      box.disabled = false;
    }
  });
}

export function buildMaximumContextSection(body: HTMLElement): void {
  const { api, jpost } = settingsClient();
  body.innerHTML = `
    <form>
      <div class="group"><div class="item context-window-controls">
        <input type="range" aria-label="Maximum context window slider (tokens)"
          min="64000" max="1000000" step="1000" value="400000">
        <span class="control"><input id="maximum-context-window" type="number"
          name="maximum" aria-label="Maximum context window (tokens)"
          min="64000" max="1000000" step="1" required> tokens</span></div></div>
      <div class="actions"><p class="msg"></p>
        <button type="submit" class="primary">Save</button></div>
    </form>`;
  const form = body.querySelector("form")!;
  const input = body.querySelector<HTMLInputElement>('input[type="number"]')!;
  const slider = body.querySelector<HTMLInputElement>('input[type="range"]')!;
  const button = body.querySelector<HTMLButtonElement>("button")!;
  const msg = body.querySelector<HTMLElement>(".msg")!;
  const show = (cls: string, text: string) => {
    msg.className = "msg " + cls;
    msg.textContent = text;
  };
  const detail = settingsDetail(body, "Maximum context window", () =>
    input.value
      ? `${Number(input.value).toLocaleString()} tokens`
      : "Checking…",
  );
  const syncSlider = () => {
    if (!input.validity.valid) return;
    slider.step = input.valueAsNumber % 1000 === 0 ? "1000" : "1";
    slider.value = input.value;
    detail.refresh();
  };
  input.addEventListener("input", syncSlider);
  slider.addEventListener("input", () => {
    input.value = slider.value;
    syncSlider();
  });
  api("/api/settings/maximum-context-window")
    .then((r) => r.json())
    .then((state: { maximum_context_window: number }) => {
      input.value = String(state.maximum_context_window);
      syncSlider();
    })
    .catch(() => show("err", "Couldn't load the maximum context window."));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    show("", "");
    try {
      const r = await jpost("/api/settings/maximum-context-window", {
        maximum_context_window: Number(input.value),
      });
      if (!r.ok) {
        show("err", await errDetail(r, "Couldn't save."));
        return;
      }
      const state = (await r.json()) as { maximum_context_window: number };
      input.value = String(state.maximum_context_window);
      syncSlider();
      show("ok", "Saved. Applies when an agent process next starts.");
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      button.disabled = false;
    }
  });
}

interface ModelListState {
  models: FinderModel[];
  reasoning: string[];
  /** Ids the composer's model menu lists; null lists every model. */
  shown: string[] | null;
}

export function buildModelMenuSection(body: HTMLElement): void {
  const { api, jpost } = settingsClient();
  body.innerHTML = `
    <div class="model-list-update">
      <button type="button" class="settings-row model-list-update-button">
        <span class="settings-row-label">Update model list</span>
        <span class="settings-row-value model-list-status" role="status"></span>
      </button>
    </div>
    <div class="shown-models-tools">
      <input type="search" class="text-field" placeholder="Filter models"
        aria-label="Filter models">
      <button type="button" class="ghost" data-show="true">Show all</button>
      <button type="button" class="ghost" data-show="false">Hide all</button>
    </div>
    <div class="group shown-models" role="group"
      aria-label="Models in the model menu"></div>
    <p class="msg"></p>`;
  const filter = body.querySelector<HTMLInputElement>("input[type=search]")!;
  const list = body.querySelector<HTMLElement>(".shown-models")!;
  const msg = body.querySelector<HTMLElement>(".msg")!;
  const listStatus = body.querySelector<HTMLElement>(".model-list-status")!;
  const updateButton = body.querySelector<HTMLButtonElement>(
    ".model-list-update-button",
  )!;
  let models: FinderModel[] = [];
  let shown = new Set<string>();
  const detail = settingsDetail(body, "Model menu", () =>
    models.length ? `${shown.size} of ${models.length} shown` : "Checking…",
  );
  const show = (cls: string, text: string) => {
    msg.className = "msg " + cls;
    msg.textContent = text;
  };
  const render = () => {
    list.textContent = "";
    const query = filter.value.trim();
    const rows = query
      ? searchModels(indexModels(models), query, models.length).models
      : models;
    if (!rows.length)
      list.textContent = models.length
        ? "No matching models"
        : "No models available. Sign in from Settings.";
    let route = "";
    for (const model of rows) {
      if (!query && model.route !== route) {
        route = model.route;
        const heading = document.createElement("p");
        heading.className = "shown-models-route";
        heading.textContent = route;
        list.append(heading);
      }
      const row = document.createElement("label");
      row.className = "item check";
      row.title = model.id;
      const name = document.createElement("span");
      name.textContent = model.label || model.id;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.model = model.id;
      box.checked = shown.has(model.id);
      row.append(box, name);
      list.append(row);
    }
    detail.refresh();
  };
  // Invariant: Every change saves the whole list; a failed save reloads the
  // stored list so the boxes never show an unsaved state.
  const save = async (next: Set<string>) => {
    const before = shown;
    shown = next;
    render();
    try {
      const r = await jpost("/api/settings/shown-models", {
        shown: models.every((m) => next.has(m.id))
          ? null
          : models.filter((m) => next.has(m.id)).map((m) => m.id),
      });
      if (!r.ok) throw new Error(await errDetail(r, "Couldn't save."));
      show("", "");
      window.dispatchEvent(new Event("recurse-model-menu-changed"));
    } catch (error) {
      shown = before;
      render();
      show("err", error instanceof Error ? error.message : "Couldn't save.");
    }
  };
  list.addEventListener("change", (event) => {
    const box = event.target as HTMLInputElement;
    const id = box.dataset.model;
    if (!id) return;
    const next = new Set(shown);
    if (box.checked) next.add(id);
    else next.delete(id);
    void save(next);
  });
  for (const button of body.querySelectorAll<HTMLButtonElement>(
    "button[data-show]",
  ))
    button.addEventListener("click", () => {
      const next = new Set(shown);
      for (const box of list.querySelectorAll<HTMLInputElement>(
        "input[data-model]",
      ))
        if (button.dataset.show === "true") next.add(box.dataset.model!);
        else next.delete(box.dataset.model!);
      void save(next);
    });
  filter.addEventListener("input", render);
  // Invariant: Only the newest load renders, so an older reply cannot replace
  // it.
  let loads = 0;
  const load = async () => {
    const current = ++loads;
    try {
      const r = await api("/api/settings/model-list");
      if (!r.ok) throw new Error();
      const state = (await r.json()) as ModelListState;
      if (current !== loads) return;
      models = state.models;
      shown = new Set(state.shown ?? models.map((m) => m.id));
      render();
    } catch {
      show("err", "Couldn't load the model list.");
    }
  };
  void load();
  const showListStatus = (status: ModelListUpdateStatus) => {
    listStatus.textContent = modelListStatusText(status);
    listStatus.classList.toggle("err", Boolean(status.error));
    updateButton.disabled = status.updating;
  };
  const followUpdate = async (status: ModelListUpdateStatus) => {
    showListStatus(status);
    for (let polls = 0; status.updating && polls < 120; polls++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!body.isConnected) return;
      status = await (await api("/api/settings/model-list-update")).json();
      showListStatus(status);
    }
    if (!status.updating) await load();
  };
  api("/api/settings/model-list-update")
    .then((r) => r.json())
    .then((status: ModelListUpdateStatus) =>
      status.updating ? followUpdate(status) : showListStatus(status),
    )
    .catch(() => (listStatus.textContent = "Couldn't read the model list."));
  updateButton.addEventListener("click", async () => {
    updateButton.disabled = true;
    try {
      const r = await jpost("/api/settings/model-list-update", {});
      if (!r.ok) {
        listStatus.textContent = await errDetail(
          r,
          "Couldn't start the update.",
        );
        updateButton.disabled = false;
        return;
      }
      await followUpdate(await r.json());
    } catch {
      listStatus.textContent = "Network error. Try again.";
      updateButton.disabled = false;
    }
  });
}
