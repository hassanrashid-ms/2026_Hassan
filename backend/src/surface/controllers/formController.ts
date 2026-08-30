import type { RequestHandler } from 'express';
import { FormAnswerBody, FormTerminateBody } from '@support/types';
import { sendError } from '../../errors.ts';
import { answerForm, terminateForm } from '../services/formService.ts';

const ERRORS = {
  not_found: [404, 'No conversation found for this player.'],
  no_form_pending: [409, 'There are no form questions to answer.'],
  unknown_field: [422, 'That question is not part of this form.'],
  invalid_value: [422, 'That answer does not match the question.'],
  unsupported_field_type: [422, 'That question type cannot be answered yet.'],
  required_fields_missing: [422, 'All required fields must be answered before continuing.'],
} as const;

export const formAnswerHandler: RequestHandler = async (req, res) => {
  const body = FormAnswerBody.safeParse(req.body);
  if (!body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'field_key must be a string and session_id, if present, a uuid.',
    );
    return;
  }

  const result = await answerForm(req.player!, body.data);
  if (!result.ok) {
    const [status, message] = ERRORS[result.reason];
    sendError(res, status, result.reason, message);
    return;
  }

  res.status(200).json({ ok: true, is_correction: result.isCorrection });
};

/** Submit and skip differ only in the fact they record. §1.3 derives the status from the rows. */
function terminateHandler(terminatedBy: 'submit' | 'skip'): RequestHandler {
  return async (req, res) => {
    const body = FormTerminateBody.safeParse(req.body ?? {});
    if (!body.success) {
      sendError(res, 422, 'invalid_request', 'session_id, if present, must be a uuid.');
      return;
    }

    const result = await terminateForm(req.player!, body.data, terminatedBy);
    if (!result.ok) {
      const [status, message] = ERRORS[result.reason];
      sendError(res, status, result.reason, message);
      return;
    }

    res
      .status(200)
      .json({ confirm_phase: 'none', status: result.status, form_status: result.formStatus });
  };
}

export const formSubmitHandler = terminateHandler('submit');
export const formSkipHandler = terminateHandler('skip');
