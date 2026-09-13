/* The target C compiler owns the variadic ABI, including Apple's arm64 stack
 * arguments. Explicit loaded function addresses avoid any compiler sysroot,
 * external SDK headers or additional runtime library search. */
typedef int (*omp_pack_openat_fn)(int directory, const char *path, int flags, ...);
typedef int (*omp_pack_fcntl_fn)(int fd, int command, ...);

int omp_pack_openat(omp_pack_openat_fn target, int directory, const char *path, int flags, unsigned int mode) {
    return target(directory, path, flags, mode);
}

int omp_pack_fcntl_pointer(omp_pack_fcntl_fn target, int fd, int command, void *argument) {
    return target(fd, command, argument);
}
