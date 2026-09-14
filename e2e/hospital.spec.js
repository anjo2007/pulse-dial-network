import { test, expect } from '@playwright/test';

async function login(page) {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('admin@centralhospital.demo');
  await page.getByLabel(/^Password/).fill('demo123');
  await page.getByRole('button', { name: 'Access emergency dashboard →' }).click();
  await expect(page.getByRole('heading', { name: 'Rapid donor dispatch' })).toBeVisible();
}

test('hospital dispatch -> donor acceptance/arrival -> desk check-in -> fulfillment', async ({ page, request }) => {
  const uncaught = [];
  page.on('pageerror', error => uncaught.push(error.message));
  await login(page);
  await page.getByLabel('Blood group').selectOption('O-');
  await page.getByLabel('Units required').fill('1');
  const createdResponse = page.waitForResponse(r => r.url().endsWith('/api/hospital/requests') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Trigger emergency dispatch' }).click();
  const created = await (await createdResponse).json();
  expect(created.id).toBeTruthy();
  const card = page.getByRole('article').filter({ has: page.locator(`[id="request-${created.id}"]`) });
  await expect(card).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(1);
  const donorAuth = await request.post('/api/auth/donor/verify', { data: { phone: '+919000000001', code: '123456' } });
  expect(donorAuth.status()).toBe(200);
  const donor = await donorAuth.json();
  const headers = { Authorization: `Bearer ${donor.token}` };
  const wrongRole = await request.get('/api/hospital/requests', { headers });
  expect(wrongRole.status()).toBe(401);
  const alerts = await (await request.get('/api/donor/alerts', { headers })).json();
  const assignment = alerts.find(a => a.request?.id === created.id);
  expect(assignment).toBeTruthy();
  const accept = await request.post(`/api/donor/assignments/${assignment.id}/respond`, { headers, data: { response: 'ACCEPT' } });
  expect(accept.status()).toBe(200);
  const accepted = await accept.json();
  expect(accepted.checkinToken).toBeTruthy();
  const arrival = await request.post(`/api/donor/assignments/${assignment.id}/arrive`, { headers });
  expect(arrival.status()).toBe(200);
  await page.getByLabel('Arrival token').fill(accepted.checkinToken);
  const checkedResponse = page.waitForResponse(r => r.url().endsWith('/api/hospital/checkin') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Verify arrival' }).click();
  expect((await checkedResponse).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Recent check-ins' })).toBeVisible();
  await page.getByRole('button', { name: /^Closed/ }).click();
  await expect(page.getByRole('article').filter({ hasText: 'O-' })).toContainText(/Fulfilled/i);
  await page.goto('/hospital/dashboard');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Rapid donor dispatch' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to dispatch' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('pulseHospital.session'))).toBeNull();
  expect(uncaught).toEqual([]);
});

test('validation, escalation, cancellation, responsive layout and JSON routing', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByLabel('Units required').fill('0');
  await page.getByRole('button', { name: 'Trigger emergency dispatch' }).click();
  await expect(page.getByText(/Enter a whole number|at least 1|between 1/i)).toBeVisible();
  await page.getByLabel('Units required').fill('2');
  await page.getByLabel('Blood group').selectOption('AB+');
  await page.getByRole('button', { name: 'Trigger emergency dispatch' }).click();
  const card = page.getByRole('article').filter({ hasText: 'AB+' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /Expand radius to 5/ }).click();
  await expect(card.getByRole('button', { name: /Expand radius to 15/ })).toBeEnabled();
  await card.getByRole('button', { name: 'Cancel request…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Cancel request|Yes, cancel/i }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: /^Closed/ }).click();
  await expect(page.getByRole('article').filter({ hasText: 'AB+' })).toContainText(/Cancelled/i);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const missing = await request.get('/api/not-a-route');
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-type']).toContain('application/json');
  const health = await request.get('/api/health');
  expect(health.headers()['cache-control']).toContain('no-store');
});
