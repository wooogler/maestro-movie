/**
 * The few sentences the agent says on its own, outside the planner: a failed
 * planner call, a rejected key, a host that is not ready. The planner writes
 * every other sentence in the conversation language (llmPlanner.ts
 * LANGUAGE_PROMPTS); these used to be English in every session.
 *
 * English is the default and is the exact text the recorded study used, which
 * ran in English. Korean was added for the UIST 2026 booth; before that a
 * Korean session heard these notices in English.
 *
 * MACHINE-DRAFTED: the Korean, Japanese and Chinese notices need native review.
 *
 * The frontend recognises these by wording as a fallback for an untagged
 * message (apps/frontend/src/voice/classifyUtterance.ts, `system.failure.*`),
 * so a reworded notice should be checked against those patterns.
 */

export type AgentNoticeKey =
  | 'hostNotReady'
  | 'filterEmpty'
  | 'genericFailure'
  | 'plannerUnavailable'
  | 'plannerUnparseable'
  | 'plannerInvalid'
  | 'apiKeyRejected'
  | 'plannerRequestFailed';

const EN: Record<AgentNoticeKey, string> = {
  hostNotReady: 'The host connection is not ready yet. I will retry once the host is available.',
  filterEmpty: 'None of the options match that filter. Let me try a different approach.',
  genericFailure: 'Something went wrong — let me try again.',
  plannerUnavailable: 'Planner model is unavailable right now. Please try again in a moment.',
  plannerUnparseable: 'I could not parse a planner output this turn. Please rephrase your request.',
  plannerInvalid: 'I could not validate the planner action against the current UI state.',
  apiKeyRejected:
    'Your OpenAI API key was rejected, so I cannot respond. Please enter a valid key and try again.',
  plannerRequestFailed: 'Planner request failed this turn. Please try again shortly.',
};

const TRANSLATED: Readonly<Record<string, Record<AgentNoticeKey, string>>> = {
  ko: {
    hostNotReady: '호스트 연결이 아직 준비되지 않았습니다. 호스트가 준비되면 다시 시도하겠습니다.',
    filterEmpty: '그 조건에 맞는 선택지가 없습니다. 다른 방법을 시도해 보겠습니다.',
    genericFailure: '문제가 발생했습니다. 다시 시도하겠습니다.',
    plannerUnavailable: '지금은 플래너 모델을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.',
    plannerUnparseable: '이번에는 플래너 응답을 해석하지 못했습니다. 다르게 말씀해 주세요.',
    plannerInvalid: '플래너의 동작을 현재 화면 상태와 대조해 확인하지 못했습니다.',
    apiKeyRejected: 'OpenAI API 키가 거부되어 응답할 수 없습니다. 올바른 키를 입력한 뒤 다시 시도해 주세요.',
    plannerRequestFailed: '이번 턴의 플래너 요청이 실패했습니다. 잠시 후 다시 시도해 주세요.',
  },
  ja: {
    hostNotReady: 'ホストとの接続がまだ準備できていません。接続でき次第、もう一度試します。',
    filterEmpty: 'その条件に合う選択肢はありません。別の方法を試します。',
    genericFailure: '問題が発生しました。もう一度試します。',
    plannerUnavailable: '現在、プランナーモデルを利用できません。少し待ってからもう一度お試しください。',
    plannerUnparseable: '今回は応答を処理できませんでした。言い方を変えてもう一度お願いします。',
    plannerInvalid: '今回の操作を現在の画面の状態と照合できませんでした。',
    apiKeyRejected: 'OpenAI APIキーが拒否されたため、応答できません。有効なキーを入力して、もう一度お試しください。',
    plannerRequestFailed: '今回はプランナーへのリクエストが失敗しました。少ししてからもう一度お試しください。',
  },
  'zh-Hans': {
    hostNotReady: '与主机的连接尚未就绪。主机可用后我会重试。',
    filterEmpty: '没有选项符合该筛选条件。我换一种方式试试。',
    genericFailure: '出了点问题，我再试一次。',
    plannerUnavailable: '规划模型暂时不可用。请稍后再试。',
    plannerUnparseable: '这一轮我没能解析规划结果。请换个说法再试。',
    plannerInvalid: '我无法根据当前界面状态验证这个操作。',
    apiKeyRejected: '您的 OpenAI API 密钥被拒绝，因此我无法回应。请输入有效的密钥后重试。',
    plannerRequestFailed: '本轮规划请求失败。请稍后再试。',
  },
  'zh-Hant': {
    hostNotReady: '與主機的連線尚未就緒。主機可用後我會重試。',
    filterEmpty: '沒有選項符合該篩選條件。我換一種方式試試。',
    genericFailure: '出了點問題，我再試一次。',
    plannerUnavailable: '規劃模型暫時無法使用。請稍後再試。',
    plannerUnparseable: '這一輪我沒能解析規劃結果。請換個說法再試。',
    plannerInvalid: '我無法根據目前介面狀態驗證這個操作。',
    apiKeyRejected: '您的 OpenAI API 金鑰遭到拒絕，因此我無法回應。請輸入有效的金鑰後再試一次。',
    plannerRequestFailed: '本輪規劃請求失敗。請稍後再試。',
  },
  de: {
    hostNotReady: 'Die Verbindung zum Host ist noch nicht bereit. Ich versuche es erneut, sobald er verfügbar ist.',
    filterEmpty: 'Keine der Optionen passt zu diesem Filter. Ich versuche es anders.',
    genericFailure: 'Etwas ist schiefgelaufen – ich versuche es noch einmal.',
    plannerUnavailable: 'Das Planungsmodell ist gerade nicht verfügbar. Bitte versuchen Sie es gleich noch einmal.',
    plannerUnparseable:
      'Ich konnte die Planerausgabe diesmal nicht verarbeiten. Bitte formulieren Sie Ihre Anfrage anders.',
    plannerInvalid: 'Ich konnte die geplante Aktion nicht mit dem aktuellen Bildschirmzustand abgleichen.',
    apiKeyRejected:
      'Ihr OpenAI-API-Schlüssel wurde abgelehnt, daher kann ich nicht antworten. Bitte geben Sie einen gültigen Schlüssel ein und versuchen Sie es erneut.',
    plannerRequestFailed: 'Die Planeranfrage ist diesmal fehlgeschlagen. Bitte versuchen Sie es gleich noch einmal.',
  },
  fr: {
    hostNotReady: "La connexion à l'hôte n'est pas encore prête. Je réessaierai dès qu'il sera disponible.",
    filterEmpty: 'Aucune option ne correspond à ce filtre. Je vais essayer autrement.',
    genericFailure: 'Un problème est survenu — je réessaie.',
    plannerUnavailable:
      'Le modèle de planification est indisponible pour le moment. Veuillez réessayer dans un instant.',
    plannerUnparseable:
      "Je n'ai pas pu interpréter la réponse du planificateur cette fois. Veuillez reformuler votre demande.",
    plannerInvalid: "Je n'ai pas pu valider l'action prévue par rapport à l'état actuel de l'écran.",
    apiKeyRejected:
      "Votre clé d'API OpenAI a été refusée, je ne peux donc pas répondre. Veuillez saisir une clé valide et réessayer.",
    plannerRequestFailed: 'La requête au planificateur a échoué cette fois. Veuillez réessayer sous peu.',
  },
  es: {
    hostNotReady:
      'La conexión con el host todavía no está lista. Volveré a intentarlo en cuanto esté disponible.',
    filterEmpty: 'Ninguna opción coincide con ese filtro. Voy a intentarlo de otra manera.',
    genericFailure: 'Algo salió mal; lo intento de nuevo.',
    plannerUnavailable:
      'El modelo de planificación no está disponible ahora mismo. Inténtelo de nuevo en un momento.',
    plannerUnparseable:
      'No pude interpretar la respuesta del planificador esta vez. Por favor, reformule su petición.',
    plannerInvalid: 'No pude validar la acción prevista con el estado actual de la pantalla.',
    apiKeyRejected:
      'Su clave de la API de OpenAI fue rechazada, así que no puedo responder. Introduzca una clave válida e inténtelo de nuevo.',
    plannerRequestFailed: 'La solicitud al planificador ha fallado esta vez. Inténtelo de nuevo en breve.',
  },
};

/** The notice in the conversation language, or the study's English text. */
export function agentNotice(key: AgentNoticeKey, language?: string): string {
  return (language ? TRANSLATED[language]?.[key] : undefined) ?? EN[key];
}

/** For checks: which languages have their own notices. */
export function translatedNoticeLanguages(): string[] {
  return Object.keys(TRANSLATED);
}
