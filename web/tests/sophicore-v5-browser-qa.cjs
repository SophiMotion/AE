// Real API UI checks. Default is read-only. Never approves, generates, or runs.
const {
  chromium,
} = require("C:/Users/lx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const base = process.env.SOPHICORE_QA_URL || "http://127.0.0.1:8877";
const resultProject =
  process.env.SOPHICORE_QA_PROJECT || "07afe6c6657d4d0295f07328e8024865";
const requestedRun = process.env.SOPHICORE_QA_RUN || null;
const draftMode = process.env.SOPHICORE_QA_MODE === "new-draft";
const output = process.env.SOPHICORE_QA_OUTPUT || null;
if (draftMode && process.env.SOPHICORE_QA_BACKEND_RESTARTED !== "yes")
  throw Error(
    "Run new-draft mode only after the user has manually restarted the existing backend; set SOPHICORE_QA_BACKEND_RESTARTED=yes after that event.",
  );
if (output && !fs.statSync(output).isDirectory())
  throw Error(
    "SOPHICORE_QA_OUTPUT must identify an existing output directory.",
  );

(async () => {
  const report = {
    mode: draftMode ? "new_draft_only" : "readonly",
    url: base,
    qa_project: resultProject,
    requested_run: requestedRun,
    browser: "headless Edge; Browser plugin not available",
    created_projects: [],
    writes: [],
    blocked: [],
    console_errors: [],
    page_errors: [],
    failed_responses: [],
    checks: [],
    screenshots: [],
  };
  const own = new Set();
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({
    viewport: { width: 1536, height: 1100 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => report.page_errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") report.console_errors.push(message.text());
  });
  page.on("response", (response) => {
    if (
      response.status() >= 400 &&
      new URL(response.url()).pathname.startsWith("/api/")
    )
      report.failed_responses.push({
        url: response.url(),
        status: response.status(),
      });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      endpoint = new URL(request.url()).pathname,
      method = request.method();
    if (["GET", "HEAD", "OPTIONS"].includes(method)) return route.continue();
    // Preview is a read-only check. All other POSTs are denied except creating
    // this script's new draft; PUT is restricted to an ID returned by its POST.
    if (method === "POST" && endpoint === "/api/prd/preview")
      return route.continue();
    if (draftMode && method === "POST" && endpoint === "/api/projects") {
      report.writes.push({ endpoint, method });
      return route.continue();
    }
    if (
      draftMode &&
      method === "PUT" &&
      own.has(endpoint.match(/^\/api\/projects\/([^/]+)$/)?.[1])
    ) {
      report.writes.push({ endpoint, method });
      return route.continue();
    }
    report.blocked.push({ endpoint, method });
    return route.abort();
  });
  async function screenshot(name) {
    if (!output) return;
    const target = path.join(output, `sophicore-v5-${report.mode}-${name}.png`);
    await page.screenshot({
      path: target,
      fullPage: false,
      animations: "disabled",
    });
    report.screenshots.push(target);
  }
  async function layout(label) {
    const value = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    report.checks.push({ label, ...value });
    assert.ok(
      value.scroll <= value.width + 1,
      `${label}: page horizontal overflow ${JSON.stringify(value)}`,
    );
  }
  async function guideStep(name) {
    await page
      .getByRole("navigation", { name: "填写步骤", exact: true })
      .getByRole("button", { name: new RegExp(name) })
      .click();
  }
  async function meaningful() {
    assert.ok((await page.title()).trim(), "page title is missing");
    await page.locator("main h1").waitFor();
    assert.ok(
      (await page.locator("main").innerText()).length > 80,
      "blank app",
    );
    assert.equal(
      await page.locator("vite-error-overlay, nextjs-portal").count(),
      0,
      "framework overlay",
    );
    assert.ok((await page.url()).startsWith(base));
  }
  async function resultChecks(label) {
    // GET only: bind the rendered checks to the designated project's actual
    // saved result instead of accepting any pair of canvases on the page.
    const projectResponse = await page.request.get(
      `${base}/api/projects/${resultProject}`,
    );
    assert.ok(
      projectResponse.ok(),
      `QA project GET failed: ${projectResponse.status()}; wait for the user's manual backend restart.`,
    );
    const project = await projectResponse.json();
    assert.equal(project.id, resultProject);
    const runId = requestedRun || project.latest_run_id;
    assert.ok(runId, "The designated QA project has no saved run.");
    const runResponse = await page.request.get(`${base}/api/runs/${runId}`);
    assert.ok(runResponse.ok(), `QA run GET failed: ${runResponse.status()}`);
    const run = await runResponse.json();
    assert.equal(run.id, runId);
    assert.equal(
      run.project_id,
      resultProject,
      "The requested run belongs to another project.",
    );
    assert.ok(
      run.result,
      "The designated run has no result yet. Finish the existing run before UI QA.",
    );
    const names =
      run.result.motion_program?.joint_names ||
      run.spec_snapshot?.prd?.intake?.motion_plan?.joint_names;
    assert.ok(
      Array.isArray(names) && names.length > 1,
      "Saved result has no full joint vector.",
    );
    const samples = (run.result.series || []).filter(
      (point) => point.positions,
    );
    assert.ok(
      samples.length > 1,
      "Saved result has no actual vector sampling.",
    );
    for (const name of names) {
      assert.ok(
        samples.every(
          (point) =>
            Number.isFinite(point.positions[name]) &&
            Number.isFinite(point.targets?.[name]),
        ),
        `${name}: incomplete actual/target vector data`,
      );
    }
    await page.goto(`${base}/?project=${resultProject}`, {
      waitUntil: "domcontentloaded",
    });
    await meaningful();
    report.checks.push({
      label: `${label}-frontend-shell`,
      title: await page.title(),
      page_errors: [...report.page_errors],
      framework_overlay: false,
    });
    await layout(`${label}-shell`);
    const projectsFailure = report.failed_responses.find(
      (item) => new URL(item.url).pathname === "/api/projects",
    );
    if (projectsFailure)
      throw Error(
        `The existing backend returned ${projectsFailure.status} for GET /api/projects. QA project loading is blocked; wait for the user's manual backend restart.`,
      );
    assert.equal(
      new URL(page.url()).searchParams.get("project"),
      resultProject,
      "The designated QA project was not loaded; refusing to inspect a different user project.",
    );
    // App.tsx wraps the select and its option text in the same label, so its
    // accessible name includes those options instead of this caption alone.
    const history = page.locator(".run-selector select");
    await history.waitFor({ state: "attached" });
    await history
      .locator(`option[value="${runId}"]`)
      .waitFor({ state: "attached" });
    // The info rail is intentionally hidden on narrow screens. Avoid acting on
    // its hidden control when the intended run is already selected. For a
    // different historical run, select through the visible desktop control,
    // then restore the actual viewport before inspecting results.
    if ((await history.inputValue()) !== runId) {
      const viewport = page.viewportSize();
      if (!(await history.isVisible()))
        await page.setViewportSize({ width: 1536, height: 1100 });
      await history.selectOption(runId);
      await page.setViewportSize(viewport);
    }
    await page
      .getByRole("heading", { name: "运行与评估", exact: true })
      .waitFor();
    await page
      .locator(".run-spec-note")
      .filter({ hasText: runId.slice(0, 8) })
      .waitFor();
    const results = page.getByRole("region", {
      name: "全组关节动作实际结果",
      exact: true,
    });
    await results
      .getByRole("heading", {
        name: "全组关节的实际动作与往返次数",
        exact: true,
      })
      .waitFor();
    {
      for (const name of names) {
        await results
          .getByLabel(
            `${name} · 实际 / 目标角度 (rad)：实际运行值与目标值随时间变化的曲线`,
            { exact: true },
          )
          .waitFor();
        assert.equal(
          await results
            .getByRole("columnheader", {
              name: `${name} 实际角度 (rad)`,
              exact: true,
            })
            .count(),
          1,
          `${name}: actual stage angle column missing`,
        );
      }
      assert.equal(
        await results.locator('canvas[aria-label*="实际 / 目标角度"]').count(),
        names.length,
        "Every program axis must have its own actual curve",
      );
      assert.ok(
        await page
          .getByRole("columnheader", {
            name: "采样时对应的计划阶段",
            exact: true,
          })
          .count(),
        "stage provenance label missing",
      );
      assert.equal(
        await page
          .getByRole("columnheader", { name: "实际进入阶段", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await results
          .getByRole("columnheader", {
            name: "最后反馈时刻（仿真秒）",
            exact: true,
          })
          .count(),
        1,
      );
      const cases = run.result.metrics?.cases || [];
      const caseLabels = {
        motion_1: "正常动作 1",
        motion_2: "正常动作 2",
        motion_3: "正常动作 3",
        command_loss: "停止发送指令",
        measurement_loss: "停止反馈测量",
        cancel: "中途取消",
      };
      for (const [name, display] of Object.entries(caseLabels)) {
        assert.ok(
          cases.some((item) => item.name === name),
          `${name}: saved scenario missing`,
        );
        const row = results.getByRole("row").filter({
          has: page.getByRole("cell", { name: display, exact: true }),
        });
        assert.equal(
          await row.count(),
          1,
          `${name}: Chinese scenario row missing`,
        );
        const checks = (run.result.checks || []).filter((check) =>
          check.name.startsWith(`${name}_`),
        );
        const allPassed =
          checks.length > 0 && checks.every((check) => check.passed === true);
        const text = await row.innerText();
        assert.ok(
          text.includes(
            allPassed ? "检查通过" : checks.length ? "检查未通过" : "缺少",
          ),
          `${name}: displayed outcome disagrees with actual checks: ${text}`,
        );
        if (!name.startsWith("motion_")) {
          assert.equal(
            await row
              .getByRole("cell", { name: "不适用（停机测试）", exact: true })
              .count(),
            2,
          );
          assert.equal(
            await results
              .getByText(`${display} · 各姿势实际到位检查`, { exact: true })
              .count(),
            0,
          );
        }
      }
      report.checks.push({
        label: `${label}-results`,
        multi_axis_canvases: await page
          .locator('canvas[aria-label*="实际 / 目标角度"]')
          .count(),
        has_result: true,
        run_id: runId,
        joint_names: names,
        actual_vector_samples: samples.length,
        chinese_scenarios: Object.keys(caseLabels),
      });
    }
    await layout(`${label}-result`);
    await screenshot(`${label}-result`);
    if (output) {
      const curves = results.locator('canvas[aria-label*="实际 / 目标角度"]');
      await curves.first().scrollIntoViewIfNeeded();
      await screenshot(`${label}-first-axis`);
      await curves.last().scrollIntoViewIfNeeded();
      await screenshot(`${label}-last-axis`);
    }
  }
  try {
    await resultChecks("desktop");
    if (draftMode) {
      await page.getByRole("button", { name: "新建任务", exact: true }).click();
      await page
        .getByLabel("你希望机器人做什么", { exact: true })
        .fill("右臂抬起，来回招手三次，最后放到身体旁边。");
      await page
        .getByLabel("工程名称", { exact: true })
        .fill(`Sophicore 浏览器 QA 新草稿 ${Date.now()}`);
      await page.getByRole("radio", { name: /来回摆动 \/ 招手/ }).click();
      await guideStep("控制哪里");
      const selector = page.getByLabel("结构模型", { exact: true });
      await selector
        .locator("option")
        .filter({ hasText: /Sophicore/i })
        .first()
        .waitFor({ state: "attached" });
      const options = await selector
        .locator("option")
        .evaluateAll((nodes) =>
          nodes.map((node) => ({ label: node.textContent, value: node.value })),
        );
      const model = options.find(
        (item) => /Sophicore/i.test(item.label || "") && item.value,
      );
      assert.ok(model, "Sophicore model option missing");
      await selector.selectOption(model.value);
      await guideStep("动作细节");
      const recipeResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/motion-v5/recipe" &&
          response.request().method() === "GET",
      );
      await page
        .getByRole("button", {
          name: "查看 Sophicore 参考姿势建议",
          exact: true,
        })
        .click();
      const recipeResult = await recipeResponse;
      assert.ok(
        recipeResult.ok(),
        `Recipe preview GET failed: ${recipeResult.status()}`,
      );
      const recipe = await recipeResult.json();
      assert.ok(
        recipe.motion_plan?.joint_names?.length > 1,
        "Recipe has no full joint vector",
      );
      await page
        .getByRole("button", {
          name: "采用这套参考姿势，随后人工核对",
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page.getByLabel("已人工核对完整姿势程序").count(),
        0,
        "preview must not already be adopted",
      );
      await screenshot("desktop-recipe-preview");
      await page
        .getByRole("button", {
          name: "采用这套参考姿势，随后人工核对",
          exact: true,
        })
        .click();
      const review = page.getByLabel("已人工核对完整姿势程序", { exact: true });
      assert.equal(await review.isChecked(), false);
      await review.check();
      const angle = page
        .locator('.motion-table input[aria-label$="角度"]')
        .first();
      const previous = Number(await angle.inputValue());
      await angle.fill(String(previous + 0.01));
      assert.equal(
        await review.isChecked(),
        false,
        "numeric edits must invalidate review",
      );
      assert.ok(
        (await page
          .locator('.motion-table input[aria-label$="角度"]')
          .count()) ===
          recipe.motion_plan.joint_names.length *
            recipe.motion_plan.waypoints.length,
        "Editable pose table must include every joint in every waypoint",
      );
      assert.equal(
        await page
          .getByText("保留的旧草稿通用参数（只读，不用于当前执行）", {
            exact: true,
          })
          .count(),
        1,
      );
      await review.check();
      await layout("desktop-draft");
      await screenshot("desktop-edited-draft");
      await page.setViewportSize({ width: 390, height: 844 });
      await angle.fill(String(previous + 0.02));
      assert.equal(
        await review.isChecked(),
        false,
        "Narrow-screen edits must invalidate review too",
      );
      await review.check();
      await layout("narrow-draft");
      await screenshot("narrow-edited-draft");
      report.checks.push({
        label: "adoption-and-edit-review",
        preview_was_unadopted: true,
        desktop_edit_invalidated_review: true,
        narrow_edit_invalidated_review: true,
        joint_names: recipe.motion_plan.joint_names,
        waypoint_count: recipe.motion_plan.waypoints.length,
      });
      await page.setViewportSize({ width: 1536, height: 1100 });
      const saving = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/projects" &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "保存需求", exact: true }).click();
      const response = await saving,
        saved = await response.json();
      assert.equal(response.status(), 200, JSON.stringify(saved));
      own.add(saved.id);
      report.created_projects.push(saved.id);
      assert.equal(saved.task_type, "joint_sequence");
      assert.equal(saved.pipeline_version, 5);
      assert.equal(saved.prd.intake.motion_plan.reviewed, true);
      assert.deepEqual(
        saved.prd.intake.motion_plan.joint_names,
        recipe.motion_plan.joint_names,
      );
      assert.equal(
        saved.prd.intake.motion_plan.waypoints.length,
        recipe.motion_plan.waypoints.length,
      );
      assert.ok(
        Math.abs(
          saved.prd.intake.motion_plan.waypoints[0].positions[0] -
            ((previous + 0.02) * Math.PI) / 180,
        ) < 1e-8,
        "Saved draft lost the user's angle edit",
      );
      assert.equal(saved.request, "右臂抬起，来回招手三次，最后放到身体旁边。");
      report.saved_snapshot = {
        id: saved.id,
        joint_names: saved.prd.intake.motion_plan.joint_names,
        waypoint_count: saved.prd.intake.motion_plan.waypoints.length,
        reviewed: true,
      };
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await resultChecks("narrow");
    assert.deepEqual(report.page_errors, []);
    assert.deepEqual(report.blocked, []);
    report.console_health = report.console_errors.length === 0;
    assert.deepEqual(report.failed_responses, []);
    assert.deepEqual(report.console_errors, []);
    if (draftMode) {
      assert.equal(
        report.created_projects.length,
        1,
        "Only the script's one new draft may be created",
      );
    } else assert.deepEqual(report.writes, []);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = String(error);
    process.exitCode = 1;
    await screenshot("error").catch(() => {});
  } finally {
    report.completed_at = new Date().toISOString();
    if (output)
      fs.writeFileSync(
        path.join(output, `sophicore-v5-${report.mode}-qa.json`),
        JSON.stringify(report, null, 2),
      );
    console.log(JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
