import type { FastifyRequest, FastifyReply } from 'fastify';
import type { UserRole } from '@buglens/shared';

const ROLE_HIERARCHY: Record<UserRole, number> = {
  viewer: 0,
  reporter: 1,
  'qa-lead': 2,
  admin: 3,
};

/**
 * Returns a prehandler that requires the user to have at least `minRole`.
 *
 * @example
 *   app.delete('/v1/bugs/:id', { preHandler: [authenticate, authorize('qa-lead')] }, handler)
 */
export function authorize(minRole: UserRole) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userRole = request.user?.role;

    if (!userRole || ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY[minRole]) {
      return reply.status(403).send({
        type: 'https://buglens.app/errors/forbidden',
        title: 'Insufficient permissions',
        status: 403,
        detail: `This action requires the '${minRole}' role or higher.`,
      });
    }
  };
}
