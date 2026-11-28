// Somente para exibição. A autorização de reprodução continua em evaluateAccess.
export const activationLicenseJoin = "LEFT JOIN licenses l ON l.id = COALESCE(a.license_id, a.granted_license_id)";
export const activationDisplayStatus = `CASE
  WHEN a.status <> 'active' OR l.is_trial IS NOT TRUE THEN a.status::text
  WHEN l.status <> 'active' THEN l.status::text
  WHEN l.expires_at <= CURRENT_TIMESTAMP THEN 'expired'
  WHEN l.starts_at IS NULL OR l.starts_at > CURRENT_TIMESTAMP THEN 'pending'
  ELSE 'trial' END`;

// Um aparelho pode ter várias listas. Qualquer vínculo regular ativo tem prioridade.
const priorities = "ARRAY['active','trial','blocked','suspended','expired','pending','cancelled','revoked']";
export const deviceDisplayStatus = `COALESCE((${priorities})[MIN(array_position(${priorities}, ${activationDisplayStatus}))], 'unlinked')`;
