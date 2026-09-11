import { redirect, type Actions, type ServerLoad } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/auth';

export const load: ServerLoad = async () => {
  throw redirect(303, '/login');
};

export const actions: Actions = {
  default: async ({ cookies }) => {
    cookies.delete(SESSION_COOKIE, { path: '/' });
    throw redirect(303, '/login');
  },
};
