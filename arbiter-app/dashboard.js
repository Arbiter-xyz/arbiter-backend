// Arbiter dashboard: lists pending questions and lets an arbiter cancel
// a question while it is still inside its cancellable window.

async function fetchPendingQuestions(apiBase) {
  const res = await fetch(`${apiBase}/payers/questions`);
  if (!res.ok) {
    throw new Error(`Failed to load pending questions: ${res.status}`);
  }
  const body = await res.json();
  return Array.isArray(body) ? body : body.questions || [];
}

function isCancellable(question) {
  // The job record exposes `cancellableUntil` (two L's). Fall back to the
  // advertised `cancelUrl` when present so we stay in sync with the backend.
  if (question.cancelUrl) {
    return true;
  }
  return Number.isFinite(question.cancellableUntil) && question.cancellableUntil > Date.now();
}

function cancelUrlFor(question) {
  if (question.cancelUrl) {
    return question.cancelUrl;
  }
  return `/oracle/${question.jobId}/cancel`;
}

async function cancelQuestion(apiBase, question) {
  const res = await fetch(`${apiBase}${cancelUrlFor(question)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Failed to cancel question: ${res.status}`);
  }
  return res.json();
}

function renderQuestionRow(apiBase, question) {
  const row = document.createElement('li');
  row.className = 'question-row';
  row.textContent = question.question || question.questionId;

  if (isCancellable(question)) {
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'cancel-question';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', async () => {
      cancelBtn.disabled = true;
      try {
        await cancelQuestion(apiBase, question);
        row.remove();
      } catch (err) {
        cancelBtn.disabled = false;
        console.error(err);
      }
    });
    row.appendChild(cancelBtn);
  }

  return row;
}

async function renderDashboard(apiBase, container) {
  const questions = await fetchPendingQuestions(apiBase);
  container.innerHTML = '';
  const list = document.createElement('ul');
  list.className = 'pending-questions';
  for (const question of questions) {
    list.appendChild(renderQuestionRow(apiBase, question));
  }
  container.appendChild(list);
}

if (typeof window !== 'undefined') {
  window.arbiterDashboard = { renderDashboard, cancelQuestion };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderDashboard, cancelQuestion, isCancellable, cancelUrlFor };
}
