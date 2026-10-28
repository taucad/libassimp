# Applies PATCH to the current directory once. FetchContent reruns the patch
# step whenever the update step runs again (a reconfigure, or a second build
# in the same tree), so a patch that is already in place is left alone.
foreach(variable IN ITEMS GIT_EXECUTABLE PATCH)
  if(NOT DEFINED ${variable})
    message(FATAL_ERROR "apply-patch.cmake needs -D${variable}=...")
  endif()
endforeach()

execute_process(
  COMMAND "${GIT_EXECUTABLE}" apply --reverse --check "${PATCH}"
  RESULT_VARIABLE already_applied
  OUTPUT_QUIET ERROR_QUIET
)
if(already_applied EQUAL 0)
  message(STATUS "Patch already applied: ${PATCH}")
  return()
endif()

execute_process(
  COMMAND "${GIT_EXECUTABLE}" apply "${PATCH}"
  RESULT_VARIABLE applied
)
if(NOT applied EQUAL 0)
  message(FATAL_ERROR "Could not apply ${PATCH}")
endif()
