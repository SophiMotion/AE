// Local-only UI acceptance. Saves an isolated draft; never calls AI or runs ROS.
const { chromium } = require('C:/Users/lx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1536, height: 1100 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(20000);
  const errors = [], writes = [], out = {};
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', r => { if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method())) writes.push(r.method() + ' ' + new URL(r.url()).pathname); });
  try {
    await page.goto('http://127.0.0.1:8877', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /V3 界面验收 · 18轴与流程/ }).first().click();
    await page.getByLabel('工程名称', { exact: true }).waitFor();
    const saved = await (await page.request.get('http://127.0.0.1:8877/api/projects/ff49ae15ce1f4b22b97d9dd7faa4d0eb')).json();
    const elbow = saved.structure.joints.find(j => j.name === saved.prd.joint_name);
    await page.getByText('506 个部件 · 模型姿态预览', { exact: true }).waitFor({ timeout: 45000 });
    out.joints = await page.locator('.structure-selectors select').nth(1).locator('option').count() - 1;
    out.joint = elbow.name;
    out.targetBounds = { min: await page.getByLabel('目标位置', { exact: true }).getAttribute('min'), max: await page.getByLabel('目标位置', { exact: true }).getAttribute('max') };
    await page.getByLabel('目标位置', { exact: true }).fill('3');
    out.excessTargetSaveDisabled = await page.getByRole('button', { name: '保存', exact: true }).isDisabled();
    await page.getByLabel('目标位置', { exact: true }).fill('0.6');
    out.saved = { id: saved.id, joint: saved.prd?.joint_name, model: saved.execution_model?.model_sha256, mesh: saved.structure?.mesh_url, order: saved.workflow?.execution_order, manifestPassed: saved.manifest?.preflight?.passed };
    await page.locator('.manifest-verdict').filter({ hasText: '配置检查通过 · 6 / 6 项' }).waitFor();
    await page.locator('.project-manifest').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'docs/ui-v3-manifest.png') });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /V3 界面验收 · 18轴与流程/ }).first().click();
    await page.getByLabel('工程名称', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.structure-selectors select')[1]?.value === 'arm_l_elbow_bend');
    out.reopenedJoint = await page.locator('.structure-selectors select').nth(1).inputValue();
    out.reopenedOrder = await page.locator('.workflow-editor .workflow-order li').allTextContents();
    await page.getByText('506 个部件 · 模型姿态预览', { exact: true }).waitFor({ timeout: 45000 });
    await page.locator('.structure-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'docs/ui-v3-model.png') });
    await page.getByRole('button', { name: '编辑流程图', exact: true }).click();
    await page.locator('.workflow-editor').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'docs/ui-v3-workflow.png') });
    await page.getByLabel('目标位置', { exact: true }).fill('0.7');
    out.stale = await page.getByText('需求已有修改，下面是上次保存的清单；保存后会重新检查。', { exact: true }).count();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(450);
    await page.locator('.project-manifest').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'docs/ui-v3-mobile.png') });
    out.mobile = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    out.errors = errors; out.writes = writes;
    if (errors.length || !out.excessTargetSaveDisabled || out.joints !== 18 || out.reopenedJoint !== elbow.name || !out.stale || out.mobile.width !== out.mobile.scroll) throw Error('Browser acceptance assertion failed');
    console.log(JSON.stringify(out));
  } catch (e) {
    console.log(JSON.stringify({ error: String(e), out, errors, writes }));
    await page.screenshot({ path: path.join(root, 'docs/ui-v3-live-error.png') });
    process.exitCode = 1;
  } finally { await browser.close(); }
})();


