// Replaces every global operator new and delete in the Linux addon with
// mimalloc. The addon's version script keeps these definitions local, so Node
// and any other addon in the process keep their own allocator.
#include <mimalloc-new-delete.h>
