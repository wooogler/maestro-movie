import type { Movie, Theater, Showing, Seat, Booking, BookingRequest } from '../types';
import type { StudyModeId } from '../pages/studyOptions';
import {
  getStoredApiKey,
  getStoredStudySession,
  type StudySessionState,
  type StudyScenarioDetail,
  type StudyScenarioSummary,
} from '../study/sessionStorage';

interface StudySessionInfo extends Omit<StudySessionState, 'studyToken'> {
  scenario: StudyScenarioSummary & {
    background: string;
    story: string;
    stepBriefs: NonNullable<StudyScenarioSummary['stepBriefs']>;
    narratorPreferenceTypes: string[];
    seatRows: string[];
  };
  background: string;
  story: string;
  stepBriefs: NonNullable<StudyScenarioSummary['stepBriefs']>;
  narratorPreferenceTypes: string[];
  status: 'active' | 'finished' | 'expired';
}

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

export const OPENAI_API_KEY_MISSING = 'OPENAI_API_KEY_MISSING';
export const OPENAI_AUTH_FAILED = 'OPENAI_AUTH_FAILED';
export const INVALID_OPENAI_API_KEY = 'INVALID_OPENAI_API_KEY';
export const DEMO_SESSION_CAPACITY_REACHED = 'DEMO_SESSION_CAPACITY_REACHED';
export const STUDY_SESSION_UNAUTHORIZED = 'STUDY_SESSION_UNAUTHORIZED';
export const ACCESS_CODE_INVALID = 'ACCESS_CODE_INVALID';
export const ACCESS_CODE_RATE_LIMITED = 'ACCESS_CODE_RATE_LIMITED';
export const ACCESS_CODES_DISABLED = 'ACCESS_CODES_DISABLED';
export const OPERATOR_KEY_UNAVAILABLE = 'OPERATOR_KEY_UNAVAILABLE';

/** Fired when the backend rejects the stored study session token. */
export const STUDY_SESSION_INVALID_EVENT = 'tuning-movie:study-session-invalid';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function getApiErrorCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}

/** Human-readable copy for the error codes the UI needs to explain. */
export function describeApiErrorCode(code: string | null): string | null {
  switch (code) {
    case OPENAI_API_KEY_MISSING:
      return 'No OpenAI API key was provided. Paste your key on the start page to use speech features.';
    case OPENAI_AUTH_FAILED:
    case INVALID_OPENAI_API_KEY:
      return 'OpenAI rejected this API key. Check that the key is active and has credit, then re-enter it.';
    case DEMO_SESSION_CAPACITY_REACHED:
      return 'The demo is at capacity right now. Please wait a minute and try again.';
    case STUDY_SESSION_UNAUTHORIZED:
      return 'This session has ended. Please start again from the beginning.';
    case ACCESS_CODE_INVALID:
      // The backend also returns a `reason`, which the start page surfaces
      // verbatim; this is the fallback when only the code is available.
      return 'That access code is not valid. Ask the presenter for a new one.';
    case ACCESS_CODE_RATE_LIMITED:
      return 'Too many incorrect codes. Please wait a few minutes, or ask the presenter.';
    case ACCESS_CODES_DISABLED:
      return 'Access codes are not enabled right now. Use your own OpenAI API key instead.';
    case OPERATOR_KEY_UNAVAILABLE:
      return 'The demo key is unavailable right now. Use your own OpenAI API key instead.';
    default:
      return null;
  }
}

interface ParsedApiError {
  message: string;
  code: string | null;
}

async function parseErrorResponse(response: Response): Promise<ParsedApiError> {
  const defaultMessage = `HTTP ${response.status}`;
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const error = await response.json().catch(() => null);
    if (error && typeof error === 'object') {
      const rawCode = (error as { error?: unknown }).error;
      const code = typeof rawCode === 'string' ? rawCode : null;
      const friendly = describeApiErrorCode(code);
      if (friendly) {
        return { message: friendly, code };
      }
      if (code) {
        return { message: code, code };
      }
      if (typeof (error as { message?: unknown }).message === 'string') {
        return { message: (error as { message: string }).message, code: null };
      }
    }
    return { message: defaultMessage, code: null };
  }

  const text = await response.text().catch(() => '');
  if (!text) return { message: defaultMessage, code: null };
  return { message: `${defaultMessage}: ${text.slice(0, 120)}`, code: null };
}

function toApiError(response: Response, parsed: ParsedApiError): ApiError {
  if (parsed.code === STUDY_SESSION_UNAUTHORIZED && typeof window !== 'undefined') {
    // Let the app shell reset to the start page instead of leaving the user
    // stuck on a screen backed by a session the backend no longer knows about.
    window.dispatchEvent(new CustomEvent(STUDY_SESSION_INVALID_EVENT));
  }
  return new ApiError(parsed.message, response.status, parsed.code);
}

interface FetchApiOptions extends RequestInit {
  includeStudyToken?: boolean;
  studyToken?: string;
}

function getStudyRequestHeaders(studyToken?: string): Record<string, string> {
  const session = getStoredStudySession();
  const resolvedStudyToken = studyToken ?? session?.studyToken;
  const headers: Record<string, string> = {};
  if (resolvedStudyToken) {
    headers['x-study-session-token'] = resolvedStudyToken;
  }
  return headers;
}

function parseContentDispositionFileName(value: string | null): string | null {
  if (!value) return null;

  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const basicMatch = value.match(/filename="?([^"]+)"?/i);
  return basicMatch?.[1] ?? null;
}

async function fetchApiResponse(endpoint: string, options?: FetchApiOptions): Promise<Response> {
  const {
    includeStudyToken = true,
    studyToken: explicitStudyToken,
    headers: optionHeaders,
    ...requestInit
  } = options ?? {};
  const headers: Record<string, string> = {
    // Only declare a JSON body when one is actually being sent. Fastify's JSON
    // content-type parser rejects an empty body with FST_ERR_CTP_EMPTY_JSON_BODY
    // *before* the route handler runs, so a bodyless POST that still advertises
    // application/json can never reach its handler.
    ...(requestInit.body === undefined || requestInit.body === null
      ? {}
      : { 'Content-Type': 'application/json' }),
    ...getStudyRequestHeaders(includeStudyToken ? explicitStudyToken : undefined),
    ...(optionHeaders as Record<string, string> | undefined),
  };
  if (!includeStudyToken) {
    delete headers['x-study-session-token'];
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...requestInit,
      headers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network request failed';
    throw new Error(
      `Cannot reach backend API (${API_BASE_URL || 'same-origin'}). ${message}`
    );
  }

  if (!response.ok) {
    throw toApiError(response, await parseErrorResponse(response));
  }

  return response;
}

async function fetchApi<T>(endpoint: string, options?: FetchApiOptions): Promise<T> {
  const response = await fetchApiResponse(endpoint, options);
  return response.json();
}

export interface StudyLogEventInput {
  type: string;
  payload: unknown;
  clientTimestamp?: string;
}

export interface PerTrialSurveySubmissionInput {
  participantId: string;
  studyMode: StudyModeId;
  conditionLabel: string;
  scenarioId?: string;
  setLabel?: string;
  responses: Record<string, number>;
}

export interface PostStudySurveySubmissionInput {
  participantId: string;
  rankings: Record<string, number>;
  rankingReason: string;
  responses: Record<string, number>;
}

export const api = {
  // Study scenarios/sessions
  getStudyScenarios: () =>
    fetchApi<{
      scenarios: StudyScenarioDetail[];
    }>('/study/scenarios', {
      includeStudyToken: false,
    }),
  createStudySession: (data: {
    scenarioId: string;
    studyMode: StudyModeId;
    participantId?: string;
    loggingParticipantId?: string;
    /**
     * Visitor-supplied OpenAI key. Sent once at session creation so the backend
     * can hold it in memory for this session; it is never echoed back.
     */
    apiKey?: string;
    /**
     * Single-use conference access code. Redeemed server-side to attach the
     * operator's key to this one session; the operator key never reaches the
     * browser. Mutually exclusive with `apiKey` in practice.
     */
    accessCode?: string;
    /**
     * The demo visitor ticked the research-recording box on the setup screen.
     * Demo only, and the only thing that makes a demo session keep any log at
     * all — so it is sent explicitly rather than defaulted anywhere.
     */
    researchConsent?: boolean;
  }) =>
    fetchApi<StudySessionState>('/study/sessions', {
      method: 'POST',
      includeStudyToken: false,
      body: JSON.stringify(data),
    }),
  getCurrentStudySession: () => fetchApi<StudySessionInfo>('/study/sessions/me'),
  finishStudySession: () =>
    fetchApi<{ sessionId: string; status: 'finished' | 'expired'; finishedAt: string | null }>(
      '/study/sessions/finish',
      {
        method: 'POST',
      }
    ),
  logStudyEvents: (events: StudyLogEventInput[], studyToken?: string) =>
    fetchApi<{ enabled: boolean; logged: number; interactionLogFile: string | null }>(
      '/study/logs/events',
      {
        method: 'POST',
        studyToken,
        keepalive: true,
        body: JSON.stringify({ events }),
      }
    ),
  submitPerTrialSurvey: (data: PerTrialSurveySubmissionInput) =>
    fetchApi<{ ok: true; submissionId: string; submittedAt: string }>(
      '/study/surveys/per-trial',
      {
        method: 'POST',
        includeStudyToken: false,
        body: JSON.stringify({
          ...data,
          submittedAt: new Date().toISOString(),
        }),
      }
    ),
  submitPostStudySurvey: (data: PostStudySurveySubmissionInput) =>
    fetchApi<{ ok: true; submissionId: string; submittedAt: string }>(
      '/study/surveys/post-study',
      {
        method: 'POST',
        includeStudyToken: false,
        body: JSON.stringify({
          ...data,
          submittedAt: new Date().toISOString(),
        }),
      }
    ),
  downloadStudyLog: async (studyToken?: string) => {
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}/study/logs/export`, {
        method: 'GET',
        headers: getStudyRequestHeaders(studyToken),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network request failed';
      throw new Error(
        `Cannot reach backend API (${API_BASE_URL || 'same-origin'}). ${message}`
      );
    }

    if (!response.ok) {
      throw toApiError(response, await parseErrorResponse(response));
    }

    return {
      blob: await response.blob(),
      fileName: parseContentDispositionFileName(response.headers.get('content-disposition')),
    };
  },
  downloadStudyLlmTrace: async (studyToken?: string) => {
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}/study/logs/llm-trace/export`, {
        method: 'GET',
        headers: getStudyRequestHeaders(studyToken),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network request failed';
      throw new Error(
        `Cannot reach backend API (${API_BASE_URL || 'same-origin'}). ${message}`
      );
    }

    if (!response.ok) {
      throw toApiError(response, await parseErrorResponse(response));
    }

    return {
      blob: await response.blob(),
      fileName: parseContentDispositionFileName(response.headers.get('content-disposition')),
    };
  },

  // Movies
  getMovies: () => fetchApi<{ movies: Movie[] }>('/movies'),
  getMovie: (id: string) => fetchApi<{ movie: Movie }>(`/movies/${id}`),

  // Theaters
  getTheaters: () => fetchApi<{ theaters: Theater[] }>('/theaters'),
  getTheatersByMovie: (movieId: string) =>
    fetchApi<{ theaters: Theater[] }>(`/theaters/movie/${movieId}`),
  getTheater: (id: string) => fetchApi<{ theater: Theater }>(`/theaters/${id}`),

  // Showings
  getShowings: (params: { movieId?: string; theaterId?: string; date?: string }) => {
    const searchParams = new URLSearchParams();
    if (params.movieId) searchParams.set('movieId', params.movieId);
    if (params.theaterId) searchParams.set('theaterId', params.theaterId);
    if (params.date) searchParams.set('date', params.date);
    return fetchApi<{ showings: Showing[] }>(`/showings?${searchParams}`);
  },
  getDates: (movieId: string, theaterId: string) =>
    fetchApi<{ dates: string[] }>(`/showings/dates?movieId=${movieId}&theaterId=${theaterId}`),
  getTimes: (movieId: string, theaterId: string, date: string) =>
    fetchApi<{ showings: Showing[] }>(
      `/showings/times?movieId=${movieId}&theaterId=${theaterId}&date=${date}`
    ),
  getShowing: (id: string) => fetchApi<{ showing: Showing }>(`/showings/${id}`),

  // Seats
  getSeats: (showingId: string) => fetchApi<{ seats: Seat[] }>(`/seats/${showingId}`),

  // Bookings
  createBooking: (data: BookingRequest) =>
    fetchApi<{ booking: Booking }>('/bookings', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getBooking: (id: string) => fetchApi<{ booking: Booking }>(`/bookings/${id}`),
  cancelBooking: (id: string) =>
    fetchApi<{ booking: Booking }>(`/bookings/${id}`, { method: 'DELETE' }),

  // Agent config
  getGuiAdaptationConfig: () => fetchApi<{ enabled: boolean }>('/agent/config/gui-adaptation'),
  setGuiAdaptationConfig: (enabled: boolean) =>
    fetchApi<{ enabled: boolean }>('/agent/config/gui-adaptation', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  /**
   * Mints a short-lived OpenAI Realtime client secret for voice mode. The
   * browser opens the WebRTC session with this secret; the real OpenAI key
   * stays on the backend.
   */
  createRealtimeVoiceSession: (language?: string) =>
    fetchApi<{
      clientSecret: string;
      expiresAt: number | null;
      model: string;
      transcriptionModel: string;
      language: string;
    }>('/speech/realtime-session',
      {
        method: 'POST',
        body: JSON.stringify(language ? { language } : {}),
      }
    ),
  /**
   * Mints the pairing token behind the "use my phone as the mic" QR. Demo-only
   * server-side; a study session gets 403 and the caller must treat that as
   * "this session has no phone voice", not as a session failure.
   */
  createCompanionPairing: () =>
    fetchApi<{ companionToken: string; expiresAt: string }>('/study/companion-token', {
      method: 'POST',
    }),
  /**
   * The paired phone's own Realtime credential.
   *
   * Carries the companion token, never the study token — the phone does not have
   * one and must not. Lives outside `/speech` deliberately: that prefix demands
   * a study token via the studyContext hook.
   */
  createCompanionRealtimeSession: (companionToken: string, language?: string) =>
    fetchApi<{
      clientSecret: string;
      expiresAt: number | null;
      model: string;
      transcriptionModel: string;
      language: string;
    }>('/study/companion/realtime-session', {
      method: 'POST',
      includeStudyToken: false,
      headers: { 'x-companion-session-token': companionToken },
      body: JSON.stringify(language ? { language } : {}),
    }),
  /**
   * Unauthenticated key check / speaker sample. This is the only call that carries
   * the inline key header: it runs before any study session exists, so there is no
   * session token the backend could resolve a key from.
   */
  synthesizeSpeechPreview: async (text: string, signal?: AbortSignal) => {
    const inlineApiKey = getStoredApiKey().trim();
    const response = await fetchApiResponse('/speech/synthesize-preview', {
      method: 'POST',
      includeStudyToken: false,
      headers: inlineApiKey ? { 'x-openai-api-key': inlineApiKey } : {},
      body: JSON.stringify({ text }),
      signal,
    });
    return response.blob();
  },
};
