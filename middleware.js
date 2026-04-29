import { NextResponse } from 'next/server';

const PUBLIC_PATH_PREFIXES = ['/api/auth', '/access.html', '/favicon.ico'];

export function middleware(req) {
  const { pathname, search } = req.nextUrl;

  if (
    PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    pathname.startsWith('/_vercel') ||
    pathname.startsWith('/.well-known')
  ) {
    return NextResponse.next();
  }

  const expected = process.env.SITE_PASSWORD || '';
  if (!expected) {
    // Fail closed if password isn't configured.
    const url = req.nextUrl.clone();
    url.pathname = '/access.html';
    url.search = '?error=not_configured';
    return NextResponse.redirect(url);
  }

  const cookieVal = req.cookies.get('siop_access')?.value || '';
  if (cookieVal === expected) {
    return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = '/access.html';
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
