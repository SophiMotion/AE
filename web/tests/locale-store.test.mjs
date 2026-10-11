import test from "node:test";
import assert from "node:assert/strict";

let sequence = 0;
async function setup(initial, blocked = false) {
  const values = new Map(initial ? [["ae.ui-language.v1", initial]] : []);
  const handlers = {};
  globalThis.window = {
    localStorage: {
      getItem: (key) => {
        if (blocked) throw new Error("Storage denied");
        return values.get(key) ?? null;
      },
      setItem: (key, value) => {
        if (blocked) throw new Error("Storage denied");
        values.set(key, value);
      },
    },
    addEventListener: (name, handler) => {
      handlers[name] = handler;
    },
  };
  globalThis.document = { documentElement: { lang: "" }, title: "" };
  const store = await import(`../src/localeStore.ts?test=${sequence++}`);
  return { store, values, handlers };
}

test("defaults to Chinese and honors only supported persisted languages", async () => {
  for (const initial of [undefined, "fr", "invalid-json"]) {
    const { store } = await setup(initial);
    assert.equal(store.getLocale(), "zh-CN");
    assert.equal(document.documentElement.lang, "zh-CN");
  }
  const { store } = await setup("en");
  assert.equal(store.getLocale(), "en");
  assert.equal(document.documentElement.lang, "en");
});

test("persists changes, notifies subscribers once and supports unsubscribe", async () => {
  const { store, values } = await setup();
  let calls = 0;
  const unsubscribe = store.subscribeLocale(() => calls++);
  store.setLocale("en");
  store.setLocale("en");
  assert.equal(calls, 1);
  assert.equal(values.get(store.LANGUAGE_STORAGE_KEY), "en");
  assert.equal(document.documentElement.lang, "en");
  unsubscribe();
  store.setLocale("zh-CN");
  assert.equal(calls, 1);
  store.setLocale("fr");
  assert.equal(store.getLocale(), "zh-CN");
});

test("storage denial does not prevent an in-memory language change", async () => {
  const { store } = await setup(undefined, true);
  assert.doesNotThrow(() => store.setLocale("en"));
  assert.equal(store.getLocale(), "en");
  assert.equal(document.documentElement.lang, "en");
});

test("only exact UI keys translate; unknown and mixed original text stays intact", async () => {
  const { store } = await setup();
  store.registerTranslations({ 设置: "Settings" });
  assert.equal(store.t("设置", "Settings"), "设置");
  store.setLocale("en");
  assert.equal(store.t("设置"), "Settings");
  assert.equal(store.t("我的设置与需求"), "我的设置与需求");
  assert.equal(store.t("新提示", "New message"), "New message");
  store.setLocale("zh-CN");
  assert.equal(store.t("设置"), "设置");
});

test("language changes synchronize across tabs without rewriting other storage", async () => {
  const { store, values, handlers } = await setup();
  let calls = 0;
  store.subscribeLocale(() => calls++);
  values.set("prd", "原始需求内容");
  values.set(store.LANGUAGE_STORAGE_KEY, "en");
  handlers.storage({ key: "prd" });
  assert.equal(calls, 0);
  handlers.storage({ key: store.LANGUAGE_STORAGE_KEY });
  assert.equal(store.getLocale(), "en");
  assert.equal(calls, 1);
  values.delete(store.LANGUAGE_STORAGE_KEY);
  handlers.storage({ key: null });
  assert.equal(store.getLocale(), "zh-CN");
  assert.equal(values.get("prd"), "原始需求内容");
});
