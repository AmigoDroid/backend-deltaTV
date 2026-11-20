import { AppError } from '../../shared/errors.js';
/** Plan visibility is an enrollment restriction, not a cancellation of an existing contract. */
export const isHiddenNetworkPlan = plan => Boolean(plan?.hiddenFromNetwork ?? plan?.hidden_from_network);
export const isPubliclySelectablePlan = plan => Boolean(plan && plan.active && !isHiddenNetworkPlan(plan));
export function assertPublicPlan(plan) {
  if (isHiddenNetworkPlan(plan)) throw new AppError(403,'PLAN_HIDDEN',
    'Este plano é reservado à administração e não pode ser contratado por convite ou autoatendimento.');
  return plan;
}
