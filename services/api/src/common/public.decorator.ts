import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'growthos:isPublic';
/** Marks a route as reachable without the X-Dev-Key header. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
