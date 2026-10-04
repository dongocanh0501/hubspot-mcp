/**
 * Independent Test & Verification Suite: HubSpot MCP Anti-Duplication Engine
 *
 * Validates:
 * 1. In-memory chronological sorting (ASCENDING & DESCENDING) without relying on HubSpot API sort param
 *    (preventing HTTP 400 Bad Request error from HubSpot /conversations/v3/conversations/threads/{id}/messages).
 * 2. computeAntiDuplicationContext algorithm:
 *    - Real-world scenario: hoangduyhien290996@gmail.com (Thread 11255090274)
 *    - Evaluation of queued messages after agent coalesced reply
 *    - New inquiries arriving after agent response
 *    - Closing remarks & short acknowledgements
 *
 * Usage: node tests/verify_anti_duplication.mjs
 */

import assert from 'node:assert/strict';

// ============================================================================
// Core Algorithm Implementations
// ============================================================================

/**
 * Extracts normalized epoch milliseconds from a message object.
 * Supports ISO strings, number timestamps, and alternative field names.
 *
 * @param {object} msg
 * @returns {number} Timestamp in milliseconds
 */
export function getMessageTimestamp(msg) {
  if (!msg) return 0;
  const raw = msg.createdAt ?? msg.timestamp ?? msg.createdDate ?? 0;
  if (typeof raw === 'number') return raw;
  const parsed = new Date(raw).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Sorts HubSpot conversation messages in memory chronologically.
 * Avoids passing sort query param to HubSpot Conversations API which causes Status 400.
 *
 * @param {Array<object>} messages - Message array
 * @param {'ASCENDING' | 'DESCENDING'} [direction='ASCENDING']
 * @returns {Array<object>} Sorted message array (shallow copy)
 */
export function sortMessages(messages, direction = 'ASCENDING') {
  if (!Array.isArray(messages)) return [];
  const isDesc = String(direction).toUpperCase() === 'DESCENDING';

  return [...messages].sort((a, b) => {
    const tA = getMessageTimestamp(a);
    const tB = getMessageTimestamp(b);
    return isDesc ? tB - tA : tA - tB;
  });
}

/**
 * Determines whether a message originates from a customer (visitor) or agent.
 *
 * @param {object} msg
 * @returns {boolean} True if customer/visitor
 */
export function isCustomerMessage(msg) {
  if (!msg) return false;
  if (typeof msg.direction === 'string') {
    return msg.direction.toUpperCase() === 'INCOMING';
  }
  const actorId = msg.senders?.[0]?.actorId || msg.createdBy || msg.actorId || '';
  if (typeof actorId === 'string') {
    if (actorId.startsWith('V-') || actorId.toUpperCase().includes('VISITOR')) return true;
    if (actorId.startsWith('A-') || actorId.toUpperCase().includes('AGENT')) return false;
  }
  return false;
}

/**
 * Determines whether a message originates from an agent or bot.
 *
 * @param {object} msg
 * @returns {boolean} True if agent/bot/outgoing
 */
export function isAgentMessage(msg) {
  if (!msg) return false;
  if (typeof msg.direction === 'string') {
    return msg.direction.toUpperCase() === 'OUTGOING';
  }
  const actorId = msg.senders?.[0]?.actorId || msg.createdBy || msg.actorId || '';
  if (typeof actorId === 'string') {
    if (actorId.startsWith('A-') || actorId.startsWith('B-') || actorId.startsWith('S-') || actorId.toUpperCase().includes('AGENT') || actorId.toUpperCase().includes('BOT') || actorId.toUpperCase().includes('USER')) return true;
    if (actorId.startsWith('V-') || actorId.toUpperCase().includes('VISITOR')) return false;
  }
  return false;
}

/**
 * Determines whether a message originates from an actual human staff member.
 *
 * @param {object} msg
 * @returns {boolean} True if human agent
 */
export function isHumanAgentMessage(msg) {
  if (!msg) return false;
  if (typeof msg.direction === 'string' && msg.direction.toUpperCase() === 'INCOMING') return false;
  const clientType = (msg.client?.clientType || '').toUpperCase();
  if (clientType === 'HUBSPOT') return true;
  if (clientType === 'SYSTEM' && typeof msg.direction === 'string' && msg.direction.toUpperCase() === 'OUTGOING') return true;
  if (clientType === 'INTEGRATION') return false;
  const actorId = msg.senders?.[0]?.actorId || msg.createdBy || msg.actorId || '';
  if (typeof actorId === 'string' && actorId.startsWith('A-')) return true;
  return false;
}

/**
 * Common short acknowledgment or closing phrases in Vietnamese.
 */
const CLOSING_PHRASES = [
  'oki', 'ok', 'oke', 'okie', 'ok nè', 'oki b an', 'oki bạn nè', 'oki bạn', 'oki b', 'ok b', 'ok bạn', 'ok shop', 'ok nhé', 'ok nha',
  'ạ', 'da', 'dạ', 'dạ vâng', 'vang', 'vâng', 'cảm ơn', 'cam on', 'cảm ơn bạn', 'cảm ơn shop',
  'thanks', 'thank you', 'tks', 'thank', 'da cam on', 'dạ cảm ơn',
  'đây nha', 'đây nha bạn', 'đây bạn', 'đây nè', 'đây nè bạn', 'đây nhé', 'đây ạ', 'đây shop', 'đây',
  'nè bạn', 'nè shop', 'nè ad', 'nè bồ', 'nè ní', 'nè',
  'xem giúp', 'xem giùm', 'xem hộ', 'xem giúp mình', 'xem giùm mình', 'xem hộ mình', 'check giúp', 'check giùm',
  'gửi bạn', 'gửi nè', 'gửi shop', 'đã gửi', 'mình gửi', 'em gửi', 'rồi nha', 'xong rồi', 'xong rùi'
];

const BURST_FOLLOWUP_REGEX = /^(đây\s*(nha|nhé|nè|ạ|ah|nhe|bạn|shop|bồ|ní)?|nè\s*(bạn|shop|ad|bồ|ní)?|xem\s*(giúp|giùm|hộ)(\s*mình|\s*em|\s*bạn)?|check\s*(giúp|giùm|hộ)|(mình|em|tui)?\s*gửi\s*(nè|ạ|nha|bạn|shop)?|(đã|mới)\s*gửi|(ok|oki|oke|okie)(\s*(nha|nhé|nè|ạ|ah|nhe|bạn|shop|ad|bồ|ní|b|roi|rồi))?|dạ|ạ|vâng|rồi\s*(nha|nhé|ạ|rùi)|xong\s*(rồi|rùi))$/i;

/**
 * Checks if a message text is simply a short acknowledgement or courtesy sign-off or burst follow-up.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isAcknowledgementMessage(text) {
  if (!text || typeof text !== 'string') return false;
  const cleaned = text.trim().toLowerCase().replace(/[.!?,;:~-]+$/g, '').trim();
  return CLOSING_PHRASES.includes(cleaned) || BURST_FOLLOWUP_REGEX.test(cleaned);
}

/**
 * Extracts plain text from various HubSpot message structures (text, body, richText).
 *
 * @param {object} msg
 * @returns {string} Plain text
 */
export function getMessageText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  if (typeof msg.text === 'string' && msg.text.trim()) return msg.text.trim();
  if (typeof msg.body === 'string' && msg.body.trim()) return msg.body.trim();
  if (typeof msg.richText === 'string' && msg.richText.trim()) {
    return msg.richText.replace(/<[^>]*>/g, '').trim();
  }
  return '';
}

/**
 * Computes deduplication and response context for a conversation thread.
 *
 * @param {Array<object>|object} input - Messages array or response object { results: [...] }
 * @param {object|string} [optionsOrCurrentText]
 * @param {string} [optionsOrCurrentText.targetMessageId] - ID of the specific message dequeued for execution
 * @param {string} [optionsOrCurrentText.currentMessageText] - Current incoming or candidate text
 * @param {boolean} [optionsOrCurrentText.enableAckDetection=false] - Check for closing/ack phrases
 * @param {string|null} [optionsOrCurrentText.assignedTo=null] - User ID assigned to this thread
 * @param {string|null} [optionsOrCurrentText.threadStatus=null] - OPEN or CLOSED
 * @param {number} [optionsOrCurrentText.humanCooldownMinutes=30] - Takeover cooldown minutes
 * @returns {object} AntiDuplicationContext
 */
export function computeAntiDuplicationContext(input, optionsOrCurrentText = {}) {
  const options = typeof optionsOrCurrentText === 'string'
    ? { currentMessageText: optionsOrCurrentText }
    : (optionsOrCurrentText || {});

  // 1. Thread Status Check
  if (options.threadStatus && options.threadStatus.toUpperCase() === 'CLOSED') {
    return {
      allRecentCustomerMessagesAddressed: true,
      needsReply: false,
      recommendedAction: 'NO_REPLY',
      reason: 'Hội thoại đã đóng (status: CLOSED). AI Bot không được gửi tin nhắn vào thread đã đóng.',
      lastAgentMessage: null,
      lastAgentReply: null,
      unrepliedMessages: [],
      unrepliedCustomerMessages: [],
      guidance: 'Thread đã đóng. BẮT BUỘC trả về NO_REPLY.'
    };
  }

  // 2. Thread Assignment Check
  if (options.assignedTo && typeof options.assignedTo === 'string' && options.assignedTo.trim() !== '') {
    return {
      allRecentCustomerMessagesAddressed: true,
      needsReply: false,
      recommendedAction: 'NO_REPLY',
      reason: `Hội thoại này đã được phân công cho nhân viên hỗ trợ (${options.assignedTo}). AI Bot tuyệt đối không được chen ngang.`,
      lastAgentMessage: null,
      lastAgentReply: null,
      unrepliedMessages: [],
      unrepliedCustomerMessages: [],
      guidance: 'Hội thoại đã có nhân viên phụ trách tiếp quản (assignedTo). LLM BẮT BUỘC trả về NO_REPLY.'
    };
  }

  const rawList = Array.isArray(input) ? input : (input?.results || input?.messages || []);
  const sortedAsc = sortMessages(rawList, 'ASCENDING');

  const customerMessages = [];
  const agentMessages = [];

  for (const msg of sortedAsc) {
    if (isCustomerMessage(msg)) {
      customerMessages.push(msg);
    } else if (isAgentMessage(msg)) {
      agentMessages.push(msg);
    }
  }

  const lastAgentReply = agentMessages.length > 0 ? agentMessages[agentMessages.length - 1] : null;
  const lastCustomerMessage = customerMessages.length > 0 ? customerMessages[customerMessages.length - 1] : null;
  const lastAgentTime = lastAgentReply ? getMessageTimestamp(lastAgentReply) : 0;
  const lastAgentText = lastAgentReply ? getMessageText(lastAgentReply) : '';

  // 3. Human Takeover Cooldown Check (default 30 mins)
  const cooldownMs = (options.humanCooldownMinutes || 30) * 60 * 1000;
  const humanAgentMessages = agentMessages.filter(isHumanAgentMessage);
  const lastHumanAgentReply = humanAgentMessages.length > 0 ? humanAgentMessages[humanAgentMessages.length - 1] : null;
  const lastHumanTime = lastHumanAgentReply ? getMessageTimestamp(lastHumanAgentReply) : 0;
  const now = Date.now();

  if (lastHumanAgentReply && (now - lastHumanTime) < cooldownMs) {
    const elapsedMins = Math.max(0, Math.round((now - lastHumanTime) / (60 * 1000)));
    const humanText = getMessageText(lastHumanAgentReply);
    return {
      allRecentCustomerMessagesAddressed: true,
      needsReply: false,
      recommendedAction: 'NO_REPLY',
      reason: `Nhân viên hỗ trợ con người vừa tương tác trong cuộc hội thoại này cách đây ${elapsedMins} phút (trong thời gian tiếp quản 30 phút). AI Bot tuyệt đối không được chen ngang.`,
      lastAgentMessage: { id: lastHumanAgentReply.id, text: humanText },
      lastAgentReply: { id: lastHumanAgentReply.id, text: humanText },
      unrepliedMessages: [],
      unrepliedCustomerMessages: [],
      guidance: `Nhân viên hỗ trợ (${lastHumanAgentReply.createdBy || 'Human Agent'}) đang trực tiếp trò chuyện với khách. LLM BẮT BUỘC trả về NO_REPLY.`
    };
  }

  // SIMULTANEOUS_TOLERANCE_MS: In real-time chat, messages sent within a few seconds of agent response
  // or before it are considered already addressed or near-simultaneous
  const SIMULTANEOUS_TOLERANCE_MS = 5000;

  // Unreplied customer messages: sent strictly AFTER the latest agent message (+ tolerance)
  const unrepliedCustomerMessages = customerMessages.filter(msg => {
    return getMessageTimestamp(msg) > (lastAgentTime + SIMULTANEOUS_TOLERANCE_MS);
  });

  const newCustomerMessagesSinceLastReply = unrepliedCustomerMessages.length;

  // Evaluate target message if provided (e.g. from GoClaw background queue worker)
  let targetMessage = null;
  let targetMessageAddressed = null;

  if (options.targetMessageId) {
    targetMessage = rawList.find(m => m.id === options.targetMessageId) || null;
    if (targetMessage) {
      const targetTime = getMessageTimestamp(targetMessage);
      // If target message was sent before or during the last agent response, it was already addressed
      targetMessageAddressed = lastAgentReply ? (targetTime <= lastAgentTime + SIMULTANEOUS_TOLERANCE_MS) : false;
    }
  }

  // Check echo / repetition of currentMessageText
  let isCurrentMessageEcho = false;
  if (options.currentMessageText && lastAgentText) {
    const curNorm = options.currentMessageText.trim().toLowerCase();
    const agNorm = lastAgentText.trim().toLowerCase();
    if (curNorm.length > 0 && (curNorm === agNorm || agNorm.includes(curNorm) || curNorm.includes(agNorm))) {
      isCurrentMessageEcho = true;
    }
  }

  let allRecentCustomerMessagesAddressed;
  let needsReply;
  let recommendedAction;
  let reason;

  if (isCurrentMessageEcho) {
    allRecentCustomerMessagesAddressed = true;
    needsReply = false;
    recommendedAction = 'NO_REPLY';
    reason = 'Nội dung tin nhắn trùng khớp với phản hồi gần nhất của Agent (outgoing echo/phản hồi lặp lại).';
  } else if (targetMessage) {
    if (targetMessageAddressed) {
      allRecentCustomerMessagesAddressed = true;
      needsReply = false;
      recommendedAction = 'NO_REPLY';
      reason = `Target message '${options.targetMessageId}' (sent ${new Date(getMessageTimestamp(targetMessage)).toISOString()}) has already been addressed by agent reply '${lastAgentReply.id}' sent at ${new Date(lastAgentTime).toISOString()}.`;
    } else {
      allRecentCustomerMessagesAddressed = false;
      needsReply = true;
      recommendedAction = 'REPLY';
      reason = `Target message '${options.targetMessageId}' was sent AFTER the last agent reply and requires attention.`;
    }
  } else {
    if (customerMessages.length === 0) {
      allRecentCustomerMessagesAddressed = true;
      needsReply = false;
      recommendedAction = 'NO_REPLY';
      reason = 'No customer messages in thread.';
    } else if (!lastAgentReply) {
      allRecentCustomerMessagesAddressed = false;
      needsReply = true;
      recommendedAction = 'REPLY';
      reason = `Customer has sent ${customerMessages.length} message(s) with no prior agent replies.`;
    } else if (newCustomerMessagesSinceLastReply === 0) {
      allRecentCustomerMessagesAddressed = true;
      needsReply = false;
      recommendedAction = 'NO_REPLY';
      const isNearSimultaneous = customerMessages.some(m => {
        const t = getMessageTimestamp(m);
        return t > lastAgentTime && t <= (lastAgentTime + SIMULTANEOUS_TOLERANCE_MS);
      });
      reason = isNearSimultaneous
        ? `Tất cả tin nhắn khách hàng gần đây đều có timestamp trước hoặc gần như đồng thời (trong vòng 5s) so với thời điểm Agent phản hồi '${lastAgentReply.id}' lúc ${new Date(lastAgentTime).toISOString()}, và Agent đã có nội dung trả lời.`
        : `All recent customer messages were sent prior to agent reply '${lastAgentReply.id}' sent at ${new Date(lastAgentTime).toISOString()}. No new messages from customer since.`;
    } else {
      allRecentCustomerMessagesAddressed = false;
      needsReply = true;
      recommendedAction = 'REPLY';
      reason = `Customer sent ${newCustomerMessagesSinceLastReply} new message(s) since last agent reply at ${new Date(lastAgentTime).toISOString()}.`;
    }
  }

  // Check if the only pending message or current message text is a brief courtesy acknowledgement / burst follow-up
  let isClosingRemark = false;
  if (options.enableAckDetection && lastAgentReply) {
    if (options.currentMessageText && isAcknowledgementMessage(options.currentMessageText)) {
      isClosingRemark = true;
      allRecentCustomerMessagesAddressed = true;
      needsReply = false;
      recommendedAction = 'NO_REPLY';
      reason = `Incoming/candidate message ("${options.currentMessageText}") is a courtesy acknowledgment or burst follow-up for prior agent reply sent at ${new Date(lastAgentTime).toISOString()}. No further reply needed.`;
    } else if (needsReply && unrepliedCustomerMessages.length === 1) {
      const pendingText = getMessageText(unrepliedCustomerMessages[0]);
      if (isAcknowledgementMessage(pendingText)) {
        isClosingRemark = true;
        allRecentCustomerMessagesAddressed = true;
        needsReply = false;
        recommendedAction = 'NO_REPLY';
        reason = `Customer message '${unrepliedCustomerMessages[0].id}' is a courtesy closing remark or burst follow-up ("${pendingText}"). No further reply needed.`;
      }
    }
  }

  const lastAgentSummary = lastAgentReply ? {
    id: lastAgentReply.id,
    text: lastAgentText,
    createdAt: lastAgentReply.createdAt || lastAgentReply.timestamp,
    createdBy: lastAgentReply.createdBy,
    direction: lastAgentReply.direction,
    timestamp: lastAgentTime
  } : null;

  const lastCustomerSummary = lastCustomerMessage ? {
    id: lastCustomerMessage.id,
    text: getMessageText(lastCustomerMessage),
    createdAt: lastCustomerMessage.createdAt || lastCustomerMessage.timestamp,
    createdBy: lastCustomerMessage.createdBy,
    direction: lastCustomerMessage.direction,
    timestamp: getMessageTimestamp(lastCustomerMessage)
  } : null;

  const unrepliedFormatted = unrepliedCustomerMessages.map(m => ({
    id: m.id,
    text: getMessageText(m),
    createdAt: m.createdAt || m.timestamp,
    createdBy: m.createdBy,
    direction: m.direction,
    timestamp: getMessageTimestamp(m)
  }));

  return {
    allRecentCustomerMessagesAddressed,
    needsReply,
    recommendedAction,
    reason,
    isClosingRemark,
    isCurrentMessageEcho,
    totalMessages: sortedAsc.length,
    newCustomerMessagesSinceLastReply,
    lastAgentReply: lastAgentSummary,
    lastCustomerMessage: lastCustomerSummary,
    unrepliedCustomerMessages: unrepliedFormatted,
    alreadyAddressedGuidance: recommendedAction === 'NO_REPLY'
      ? `[ANTI-DUPLICATION NOTICE] This message or topic has already been addressed by agent reply at ${lastAgentReply ? new Date(lastAgentTime).toISOString() : 'N/A'}. Do NOT send a duplicate message. Return NO_REPLY.`
      : null
  };
}

// ============================================================================
// Test Suite Runner & Assertions
// ============================================================================

console.log('='.repeat(75));
console.log('🧪 HUBSPOT MCP ANTI-DUPLICATION ENGINE: INDEPENDENT VERIFICATION SUITE');
console.log('='.repeat(75));

let passCount = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✅ [PASS] ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// ----------------------------------------------------------------------------
// Test Data Setup: Real-World Incident hoangduyhien290996@gmail.com
// ----------------------------------------------------------------------------
const msg1 = {
  id: 'msg-1',
  direction: 'INCOMING',
  senders: [{ actorId: 'V-252505018409' }],
  createdAt: '2026-10-03T10:42:03Z',
  text: 'Tối 9h hơn gì đc k bác'
};

const msg2 = {
  id: 'msg-2',
  direction: 'INCOMING',
  senders: [{ actorId: 'V-252505018409' }],
  createdAt: '2026-10-03T10:42:12Z',
  text: 'Mình chạy xe ô tô đi xa rùi'
};

const msg3 = {
  id: 'msg-3',
  direction: 'OUTGOING',
  senders: [{ actorId: 'A-61685315' }],
  createdAt: '2026-10-03T10:42:33Z',
  text: 'Dạ bồ cứ đi đường an toàn hen, khi nào dừng xe, rảnh sau 9h tối thì nhắn lại bên tui để tiếp tục vụ thêm thẻ vào PayPal nghen.'
};

const msg4 = {
  id: 'msg-4',
  direction: 'INCOMING',
  senders: [{ actorId: 'V-252505018409' }],
  createdAt: '2026-10-03T10:50:00Z',
  text: 'Bác cho em hỏi thẻ Sacombank có dùng được không?'
};

// ----------------------------------------------------------------------------
// TEST CASE 1: Real-world Scenario (hoangduyhien290996@gmail.com)
// ----------------------------------------------------------------------------
console.log('\n--- 📌 TEST CASE 1: Real-world Incident (hoangduyhien290996@gmail.com) ---');

runTest('Test Case 1A: Dequeued Msg 2 evaluated with targetMessageId after Msg 3 was sent', () => {
  const threadHistory = [msg1, msg2, msg3];

  const context = computeAntiDuplicationContext(threadHistory, { targetMessageId: 'msg-2' });

  assert.equal(context.allRecentCustomerMessagesAddressed, true, 'allRecentCustomerMessagesAddressed should be true');
  assert.equal(context.recommendedAction, 'NO_REPLY', "recommendedAction should be 'NO_REPLY'");
  assert.equal(context.needsReply, false, 'needsReply should be false');
  assert.equal(context.newCustomerMessagesSinceLastReply, 0, 'newCustomerMessagesSinceLastReply should be 0');
  assert.ok(context.alreadyAddressedGuidance, 'alreadyAddressedGuidance should be populated');
  assert.ok(context.alreadyAddressedGuidance.includes('NO_REPLY'), 'Guidance should instruct NO_REPLY');
  assert.equal(context.lastAgentReply.id, 'msg-3');
});

runTest('Test Case 1B: Thread-level context after Msg 3 was sent (without targetMessageId)', () => {
  const threadHistory = [msg1, msg2, msg3];

  const context = computeAntiDuplicationContext(threadHistory);

  assert.equal(context.allRecentCustomerMessagesAddressed, true, 'allRecentCustomerMessagesAddressed should be true');
  assert.equal(context.recommendedAction, 'NO_REPLY', "recommendedAction should be 'NO_REPLY'");
  assert.equal(context.needsReply, false, 'needsReply should be false');
  assert.equal(context.unrepliedCustomerMessages.length, 0, 'No unreplied customer messages');
});

// ----------------------------------------------------------------------------
// TEST CASE 2: Customer sends brand new inquiry after agent reply
// ----------------------------------------------------------------------------
console.log('\n--- 📌 TEST CASE 2: New Customer Message After Agent Reply ---');

runTest('Test Case 2A: Msg 4 arrives at 10:50:00Z after Msg 3 (10:42:33Z)', () => {
  const threadHistory = [msg1, msg2, msg3, msg4];

  const context = computeAntiDuplicationContext(threadHistory);

  assert.equal(context.needsReply, true, 'needsReply should be true');
  assert.equal(context.recommendedAction, 'REPLY', "recommendedAction should be 'REPLY'");
  assert.equal(context.allRecentCustomerMessagesAddressed, false, 'allRecentCustomerMessagesAddressed should be false');
  assert.equal(context.newCustomerMessagesSinceLastReply, 1, 'Exactly 1 unreplied customer message');
  assert.equal(context.unrepliedCustomerMessages[0].id, 'msg-4');
  assert.equal(context.unrepliedCustomerMessages[0].text, 'Bác cho em hỏi thẻ Sacombank có dùng được không?');
  assert.equal(context.alreadyAddressedGuidance, null, 'Guidance should be null when reply is needed');
});

runTest('Test Case 2B: Targeted evaluation of Msg 4 directly', () => {
  const threadHistory = [msg1, msg2, msg3, msg4];

  const context = computeAntiDuplicationContext(threadHistory, { targetMessageId: 'msg-4' });

  assert.equal(context.needsReply, true, 'needsReply should be true');
  assert.equal(context.recommendedAction, 'REPLY', "recommendedAction should be 'REPLY'");
  assert.equal(context.allRecentCustomerMessagesAddressed, false, 'allRecentCustomerMessagesAddressed should be false');
});

// ----------------------------------------------------------------------------
// TEST CASE 3: In-Memory Chronological Sorting (ASCENDING & DESCENDING)
// ----------------------------------------------------------------------------
console.log('\n--- 📌 TEST CASE 3: In-Memory Chronological Sorting ---');

runTest('Test Case 3A: Sort ASCENDING correctly orders unordered messages by timestamp', () => {
  // Pass in randomized / reversed order
  const unordered = [msg3, msg1, msg4, msg2];

  const sortedAsc = sortMessages(unordered, 'ASCENDING');

  assert.equal(sortedAsc.length, 4);
  assert.equal(sortedAsc[0].id, 'msg-1', 'msg-1 (10:42:03Z) must be first');
  assert.equal(sortedAsc[1].id, 'msg-2', 'msg-2 (10:42:12Z) must be second');
  assert.equal(sortedAsc[2].id, 'msg-3', 'msg-3 (10:42:33Z) must be third');
  assert.equal(sortedAsc[3].id, 'msg-4', 'msg-4 (10:50:00Z) must be fourth');

  // Verify timestamps strictly non-decreasing
  for (let i = 0; i < sortedAsc.length - 1; i++) {
    const tCurrent = getMessageTimestamp(sortedAsc[i]);
    const tNext = getMessageTimestamp(sortedAsc[i + 1]);
    assert.ok(tCurrent <= tNext, `Timestamp ${tCurrent} <= ${tNext}`);
  }
});

runTest('Test Case 3B: Sort DESCENDING correctly orders unordered messages (newest first)', () => {
  const unordered = [msg2, msg4, msg1, msg3];

  const sortedDesc = sortMessages(unordered, 'DESCENDING');

  assert.equal(sortedDesc.length, 4);
  assert.equal(sortedDesc[0].id, 'msg-4', 'msg-4 (10:50:00Z) must be first');
  assert.equal(sortedDesc[1].id, 'msg-3', 'msg-3 (10:42:33Z) must be second');
  assert.equal(sortedDesc[2].id, 'msg-2', 'msg-2 (10:42:12Z) must be third');
  assert.equal(sortedDesc[3].id, 'msg-1', 'msg-1 (10:42:03Z) must be fourth');

  // Verify timestamps strictly non-increasing
  for (let i = 0; i < sortedDesc.length - 1; i++) {
    const tCurrent = getMessageTimestamp(sortedDesc[i]);
    const tNext = getMessageTimestamp(sortedDesc[i + 1]);
    assert.ok(tCurrent >= tNext, `Timestamp ${tCurrent} >= ${tNext}`);
  }
});

runTest('Test Case 3C: Sorting handles numeric millisecond timestamps and mixed types', () => {
  const m1 = { id: 'num-1', createdAt: 1700000000000 };
  const m2 = { id: 'num-2', createdAt: 1700000010000 };
  const m3 = { id: 'iso-3', createdAt: '2023-11-14T22:13:40Z' }; // 1700000020000

  const sorted = sortMessages([m3, m1, m2], 'ASCENDING');
  assert.equal(sorted[0].id, 'num-1');
  assert.equal(sorted[1].id, 'num-2');
  assert.equal(sorted[2].id, 'iso-3');
});

// ----------------------------------------------------------------------------
// TEST CASE 4: Edge Cases & Courtesy Acknowledgements
// ----------------------------------------------------------------------------
console.log('\n--- 📌 TEST CASE 4: Edge Cases & Courtesy Acknowledgements ---');

runTest('Test Case 4A: Courtesy acknowledgment message ("Oki b an") with enableAckDetection', () => {
  const ackMsg = {
    id: 'msg-ack',
    direction: 'INCOMING',
    createdAt: '2026-10-03T10:42:44Z',
    text: 'Oki b an'
  };

  const threadHistory = [msg1, msg2, msg3, ackMsg];
  const context = computeAntiDuplicationContext(threadHistory, { enableAckDetection: true });

  assert.equal(context.isClosingRemark, true, 'Should detect closing remark');
  assert.equal(context.allRecentCustomerMessagesAddressed, true);
  assert.equal(context.recommendedAction, 'NO_REPLY');
  assert.equal(context.needsReply, false);
});

runTest('Test Case 4B: Empty thread or null input', () => {
  const contextEmpty = computeAntiDuplicationContext([]);
  assert.equal(contextEmpty.allRecentCustomerMessagesAddressed, true);
  assert.equal(contextEmpty.recommendedAction, 'NO_REPLY');
  assert.equal(contextEmpty.needsReply, false);

  const contextNull = computeAntiDuplicationContext(null);
  assert.equal(contextNull.allRecentCustomerMessagesAddressed, true);
  assert.equal(contextNull.recommendedAction, 'NO_REPLY');
});

runTest('Test Case 4C: Brand new thread with no agent reply yet', () => {
  const freshThread = [msg1, msg2];
  const context = computeAntiDuplicationContext(freshThread);

  assert.equal(context.allRecentCustomerMessagesAddressed, false);
  assert.equal(context.needsReply, true);
  assert.equal(context.recommendedAction, 'REPLY');
  assert.equal(context.newCustomerMessagesSinceLastReply, 2);
  assert.equal(context.lastAgentReply, null);
});

runTest('Test Case 4D: Response wrapper object { results: [...] } support', () => {
  const wrapped = { results: [msg1, msg2, msg3] };
  const context = computeAntiDuplicationContext(wrapped);

  assert.equal(context.allRecentCustomerMessagesAddressed, true);
  assert.equal(context.recommendedAction, 'NO_REPLY');
});

// ----------------------------------------------------------------------------
// TEST CASE 5: Real-World Incident (nhintt018@gmail.com - Thread 11250236293)
// Burst Image + Short Follow-up ("đây nha bạn")
// ----------------------------------------------------------------------------
console.log('\n--- 📌 TEST CASE 5: Real-world Incident (nhintt018@gmail.com - Burst & Zero-Tool Guard) ---');

const burstMsg1 = {
  id: 'burst-msg-1',
  direction: 'INCOMING',
  senders: [{ actorId: 'V-252259644968' }],
  createdAt: '2026-10-03T13:25:36.035Z',
  text: 'https://hubspot-attachments.s3.amazonaws.com/qr-bank.jpg'
};

const burstMsg2 = {
  id: 'burst-msg-2',
  direction: 'INCOMING',
  senders: [{ actorId: 'V-252259644968' }],
  createdAt: '2026-10-03T13:25:36.680Z',
  text: 'đây nha bạn'
};

const burstMsg3 = {
  id: 'burst-msg-3',
  direction: 'OUTGOING',
  senders: [{ actorId: 'A-61685315' }],
  createdAt: '2026-10-03T13:26:48.615Z',
  text: 'Dạ tui thấy ảnh mã QR ngân hàng MB của bồ rồi hen, để tui tiến hành hỗ trợ xác thực tài khoản nhé!'
};

runTest('Test Case 5A: Queue worker dequeues burstMsg2 ("đây nha bạn") after Agent already replied to burstMsg1', () => {
  const threadHistory = [burstMsg1, burstMsg2, burstMsg3];

  const context = computeAntiDuplicationContext(threadHistory, { targetMessageId: 'burst-msg-2' });

  assert.equal(context.allRecentCustomerMessagesAddressed, true, 'burstMsg2 was created prior to agent reply burstMsg3');
  assert.equal(context.recommendedAction, 'NO_REPLY', "recommendedAction should be 'NO_REPLY'");
  assert.equal(context.needsReply, false, 'needsReply should be false');
  assert.ok(context.alreadyAddressedGuidance, 'alreadyAddressedGuidance must be provided');
  assert.ok(context.alreadyAddressedGuidance.includes('NO_REPLY'));
});

runTest('Test Case 5B: Direct incoming check on candidate text ("đây nha bạn") with enableAckDetection', () => {
  const threadHistory = [burstMsg1, burstMsg2, burstMsg3];

  const context = computeAntiDuplicationContext(threadHistory, {
    currentMessageText: 'đây nha bạn',
    enableAckDetection: true
  });

  assert.equal(context.isClosingRemark, true, 'Should detect burst follow-up regex');
  assert.equal(context.recommendedAction, 'NO_REPLY');
  assert.equal(context.needsReply, false);
  assert.equal(context.allRecentCustomerMessagesAddressed, true);
});

runTest('Test Case 5C: Outgoing echo detection (candidate text matches prior agent response)', () => {
  const threadHistory = [burstMsg1, burstMsg2, burstMsg3];

  const context = computeAntiDuplicationContext(threadHistory, {
    currentMessageText: 'Dạ tui thấy ảnh mã QR ngân hàng MB của bồ rồi hen'
  });

  assert.equal(context.isCurrentMessageEcho, true, 'Should detect identical/contained agent echo');
  assert.equal(context.recommendedAction, 'NO_REPLY');
  assert.equal(context.needsReply, false);
});

runTest('Test Case 5D: Variety of Vietnamese burst continuation phrases recognized', () => {
  const testPhrases = [
    'đây nha', 'đây nha bạn', 'đây nè bạn', 'nè bạn', 'xem giúp mình',
    'check giúp', 'mình gửi nha', 'đã gửi', 'xong rồi', 'dạ', 'oki bạn'
  ];

  for (const phrase of testPhrases) {
    assert.equal(
      isAcknowledgementMessage(phrase),
      true,
      `Phrase "${phrase}" must be recognized as acknowledgment or burst follow-up`
    );
  }
});

// ----------------------------------------------------------------------------
// TEST CASE 6: Human Takeover, Thread Assignment & Status Guard
// Validates prevention of AI interruption when human staff is active or assigned
// ----------------------------------------------------------------------------
console.log('\n--- 📌 TEST CASE 6: Human Takeover & Thread Assignment Guard ---');

runTest('Test Case 6A: Thread assigned to human staff (assignedTo: "A-61685315")', () => {
  const customerPendingMsg = {
    id: 'cust-msg-99',
    direction: 'INCOMING',
    senders: [{ actorId: 'V-12345' }],
    createdAt: new Date().toISOString(),
    text: 'Shop còn hàng không ạ?'
  };

  const context = computeAntiDuplicationContext([customerPendingMsg], {
    assignedTo: 'A-61685315'
  });

  assert.equal(context.needsReply, false, 'Should NEVER reply if thread is assigned to human staff');
  assert.equal(context.recommendedAction, 'NO_REPLY');
  assert.ok(context.reason.includes('A-61685315'));
});

runTest('Test Case 6B: Thread is closed (threadStatus: "CLOSED")', () => {
  const customerPendingMsg = {
    id: 'cust-msg-100',
    direction: 'INCOMING',
    senders: [{ actorId: 'V-12345' }],
    createdAt: new Date().toISOString(),
    text: 'Cảm ơn shop'
  };

  const context = computeAntiDuplicationContext([customerPendingMsg], {
    threadStatus: 'CLOSED'
  });

  assert.equal(context.needsReply, false, 'Should NEVER reply to closed thread');
  assert.equal(context.recommendedAction, 'NO_REPLY');
  assert.ok(context.reason.includes('CLOSED'));
});

runTest('Test Case 6C: Human staff sent message via HubSpot web client 5 minutes ago (Takeover Cooldown)', () => {
  const humanStaffMsg = {
    id: 'staff-msg-1',
    direction: 'OUTGOING',
    createdBy: 'A-61685315',
    client: { clientType: 'HUBSPOT' },
    senders: [{ actorId: 'A-61685315' }],
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    text: 'Dạ bồ đợi tui kiểm tra kho một chút nhé'
  };

  const customerFollowupMsg = {
    id: 'cust-msg-101',
    direction: 'INCOMING',
    createdBy: 'V-12345',
    senders: [{ actorId: 'V-12345' }],
    createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    text: 'Mình lấy loại màu xanh dương nha bồ'
  };

  const context = computeAntiDuplicationContext([humanStaffMsg, customerFollowupMsg], {
    humanCooldownMinutes: 30
  });

  assert.equal(context.needsReply, false, 'Human active within 30m takeover cooldown must suppress AI reply');
  assert.equal(context.recommendedAction, 'NO_REPLY');
  assert.ok(context.reason.includes('tiếp quản 30 phút') || context.reason.includes('Nhân viên hỗ trợ'));
});

runTest('Test Case 6D: Bot message (clientType: "INTEGRATION") does NOT trigger human takeover cooldown', () => {
  const botMsg = {
    id: 'bot-msg-1',
    direction: 'OUTGOING',
    createdBy: 'A-61685315',
    client: { clientType: 'INTEGRATION' },
    senders: [{ actorId: 'A-61685315' }],
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    text: 'Dạ chào bồ, bồ cần hỗ trợ gì hen?'
  };

  const customerNewInquiry = {
    id: 'cust-msg-102',
    direction: 'INCOMING',
    createdBy: 'V-12345',
    senders: [{ actorId: 'V-12345' }],
    createdAt: new Date(Date.now() - 1 * 60 * 1000).toISOString(),
    text: 'Mình muốn mua 10 acc Gmail'
  };

  const context = computeAntiDuplicationContext([botMsg, customerNewInquiry]);

  assert.equal(context.needsReply, true, 'Bot reply does not trigger human cooldown; new customer inquiry requires reply');
  assert.equal(context.recommendedAction, 'REPLY');
});

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------
console.log('\n' + '='.repeat(75));
console.log(`🏁 VERIFICATION COMPLETE: ${passCount}/${totalTests} Tests Passed (100% SUCCESS)`);
console.log('='.repeat(75) + '\n');


