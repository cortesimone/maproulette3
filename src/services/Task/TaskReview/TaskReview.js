import _get from 'lodash/get'
import _set from 'lodash/set'
import _isArray from 'lodash/isArray'
import _cloneDeep from 'lodash/cloneDeep'
import _snakeCase from 'lodash/snakeCase'
import _uniqueId from 'lodash/uniqueId'
import format from 'date-fns/format'
import Endpoint from '../../Server/Endpoint'
import { defaultRoutes as api, isSecurityError } from '../../Server/Server'
import { RECEIVE_REVIEW_NEEDED_TASKS } from './TaskReviewNeeded'
import { RECEIVE_REVIEWED_TASKS,
         RECEIVE_REVIEWED_BY_USER_TASKS } from './TaskReviewed'
import RequestStatus from '../../Server/RequestStatus'
import { taskSchema, retrieveChallengeTask, receiveTasks, fetchTask } from '.././Task'
import { addError } from '../../Error/Error'
import AppErrors from '../../Error/AppErrors'
import { ensureUserLoggedIn } from '../../User/User'


export const MARK_REVIEW_DATA_STALE = "MARK_REVIEW_DATA_STALE"

export const REVIEW_TASKS_TO_BE_REVIEWED = 'tasksToBeReviewed'
export const MY_REVIEWED_TASKS = 'myReviewedTasks'
export const REVIEW_TASKS_BY_ME = 'tasksReviewedByMe'

export const ReviewTasksType = {
  toBeReviewed: REVIEW_TASKS_TO_BE_REVIEWED,
  myReviewedTasks: MY_REVIEWED_TASKS,
  reviewedByMe: REVIEW_TASKS_BY_ME
}

// redux action creators
export const RECEIVE_REVIEW_METRICS = 'RECEIVE_REVIEW_METRICS'
export const RECEIVE_REVIEW_CLUSTERS = 'RECEIVE_REVIEW_CLUSTERS'

/**
 * Mark the current review data as stale, meaning the app has been
 * informed or detected that updated task-review data is available
 * from the server
 */
export const markReviewDataStale = function() {
  return {
    type: MARK_REVIEW_DATA_STALE,
  }
}

/**
 * Add or replace the review metrics in the redux store
 */
export const receiveReviewMetrics = function(metrics, status=RequestStatus.success) {
  return {
    type: RECEIVE_REVIEW_METRICS,
    status,
    metrics,
    receivedAt: Date.now(),
  }
}

/**
 * Add or replace the review clusters in the redux store
 */
export const receiveReviewClusters = function(clusters, status=RequestStatus.success, fetchId) {
  return {
    type: RECEIVE_REVIEW_CLUSTERS,
    status,
    clusters,
    receivedAt: Date.now(),
    fetchId
  }
}

/**
 * Retrieve metrics for a given review tasks type and filter criteria
 */
 export const fetchReviewMetrics = function(reviewTasksType, criteria) {
  const searchParameters = setupFilterSearchParameters(_get(criteria, 'filters', {}),
                                                       criteria.boundingBox,
                                                       _get(criteria, 'savedChallengesOnly'))

  const type = determineType(reviewTasksType)

  return function(dispatch) {
    return new Endpoint(
      api.tasks.reviewMetrics,
      {
        schema: null,
        params: {reviewTasksType: type, ...searchParameters},
      }
    ).execute().then(normalizedResults => {
      if (normalizedResults.length > 0) {
        dispatch(receiveReviewMetrics(normalizedResults[0], RequestStatus.success))
      }

      return normalizedResults
    }).catch((error) => {
      console.log(error.response || error)
    })
  }
}

/**
 * Retrieve clustered tasks for given review criteria
 */
 export const fetchClusteredReviewTasks = function(reviewTasksType, criteria) {
  const searchParameters = setupFilterSearchParameters(_get(criteria, 'filters', {}),
                                                       criteria.boundingBox,
                                                       _get(criteria, 'savedChallengesOnly'))
  return function(dispatch) {
    const type = determineType(reviewTasksType)
    const fetchId = _uniqueId()

    dispatch(receiveReviewClusters([], RequestStatus.inProgress, fetchId))
    return new Endpoint(
      api.tasks.fetchReviewClusters,
      {
        schema: {tasks: [taskSchema()]},
        params: {reviewTasksType: type, points: 25, ...searchParameters},
      }
    ).execute().then(normalizedResults => {
      if (normalizedResults.result) {
        dispatch(receiveReviewClusters(normalizedResults.result, RequestStatus.success, fetchId))
      }

      return normalizedResults.result
    }).catch((error) => {
      dispatch(receiveReviewClusters([], RequestStatus.error, fetchId))
      console.log(error.response || error)
    })
  }
}

const determineType = (reviewTasksType) => {
  switch(reviewTasksType) {
    case ReviewTasksType.toBeReviewed:
      return 1
    case ReviewTasksType.reviewedByMe:
      return 2
    case ReviewTasksType.myReviewedTasks:
    default:
      return 3
  }
}


/**
 * Retrieve the next task to review with the given sort and filter criteria
 */
export const loadNextReviewTask = function(criteria={}) {
  const sortBy = _get(criteria, 'sortCriteria.sortBy')
  const order = (_get(criteria, 'sortCriteria.direction') || 'DESC').toUpperCase()
  const sort = sortBy ? `${_snakeCase(sortBy)}` : null
  const searchParameters = setupFilterSearchParameters(_get(criteria, 'filters', {}),
                                                       criteria.boundingBox,
                                                       _get(criteria, 'savedChallengesOnly')                                                       )

  return function(dispatch) {
    return retrieveChallengeTask(dispatch, new Endpoint(
      api.tasks.reviewNext,
      {
        schema: taskSchema(),
        variables: {},
        params: {sort, order, ...searchParameters},
      }
    ))
  }
}

/**
 * Fetch data for the given task and claim it for review.
 *
 * If info on available mapillary images for the task is also desired, set
 * includeMapillary to true
 */
export const fetchTaskForReview = function(taskId, includeMapillary=false) {
  return function(dispatch) {
    return new Endpoint(api.task.startReview, {
      schema: taskSchema(),
      variables: {id: taskId},
      params: {mapillary: includeMapillary}
    }).execute().then(normalizedResults => {
      dispatch(receiveTasks(normalizedResults.entities))
      return normalizedResults
    })
  }
}

/**
 * Remove the task review claim on this task.
 */
export const cancelReviewClaim = function(taskId) {
  return function(dispatch) {
    return new Endpoint(
      api.task.cancelReview, {schema: taskSchema(), variables: {id: taskId}}
    ).execute().then(normalizedResults => {
      // Server doesn't explicitly return empty fields from JSON.
      // This field should now be null so we will set it so when the
      // task data is merged with existing task data it will be correct.
      normalizedResults.entities.tasks[taskId].reviewClaimedBy = null
      dispatch(receiveTasks(normalizedResults.entities))
      return normalizedResults
    }).catch(error => {
      if (isSecurityError(error)) {
        dispatch(ensureUserLoggedIn()).then(() =>
          dispatch(addError(AppErrors.user.unauthorized))
        )
      }
      else {
        console.log(error.response || error)
      }
      fetchTask(taskId)(dispatch) // Fetch accurate task data
    })
  }
}

/**
 *
 */
export const completeReview = function(taskId, taskReviewStatus, comment) {
  return function(dispatch) {
    return updateTaskReviewStatus(dispatch, taskId, taskReviewStatus, comment)
  }
}

/**
 * Sets up the search parameters that the server expects.
 */
export const setupFilterSearchParameters = (filters, boundingBox, savedChallengesOnly) => {
  const searchParameters = {}
  if (filters.reviewRequestedBy) {
    searchParameters.o = filters.reviewRequestedBy
  }
  if (filters.reviewedBy) {
    searchParameters.r = filters.reviewedBy
  }
  if (filters.challenge) {
    searchParameters.cs = filters.challenge
  }
  if (filters.project) {
    searchParameters.ps = filters.project
  }
  if (filters.status && filters.status !== "all") {
    searchParameters.tStatus = filters.status
  }
  if (filters.reviewStatus && filters.reviewStatus !== "all") {
    searchParameters.trStatus = filters.reviewStatus
  }
  if (filters.reviewedAt) {
    searchParameters.startDate = format(filters.reviewedAt, 'YYYY-MM-DD')
    searchParameters.endDate = format(filters.reviewedAt, 'YYYY-MM-DD')
  }

  if (boundingBox) {
    //tbb =>  [left, bottom, right, top]
    searchParameters.tbb = boundingBox
  }

  if (savedChallengesOnly) {
    searchParameters.onlySaved = savedChallengesOnly
  }

  return searchParameters
}

const updateTaskReviewStatus = function(dispatch, taskId, newStatus, comment) {
  // Optimistically assume request will succeed. The store will be updated
  // with fresh task data from the server if the save encounters an error.
  dispatch(receiveTasks({
    tasks: {
      [taskId]: {
        id: taskId,
        status: newStatus
      }
    }
  }))

  return new Endpoint(
    api.task.updateReviewStatus,
    {schema: taskSchema(), variables: {id: taskId, status: newStatus}, params:{comment: comment}}
  ).execute().catch(error => {
    if (isSecurityError(error)) {
      dispatch(ensureUserLoggedIn()).then(() =>
        dispatch(addError(AppErrors.user.unauthorized))
      )
    }
    else {
      dispatch(addError(AppErrors.task.updateFailure))
      console.log(error.response || error)
    }
    fetchTask(taskId)(dispatch) // Fetch accurate task data
  })
}

// redux reducers
export const currentReviewTasks = function(state={}, action) {
  let updatedState = null

  switch(action.type) {
    case MARK_REVIEW_DATA_STALE:
      updatedState = _cloneDeep(state)
      _set(updatedState, 'reviewNeeded.dataStale', true)
      _set(updatedState, 'reviewed.dataStale', true)
      _set(updatedState, 'reviewedByUser.dataStale', true)
      return updatedState
    case RECEIVE_REVIEWED_TASKS:
      return updateReduxState(state, action, "reviewed")
    case RECEIVE_REVIEWED_BY_USER_TASKS:
      return updateReduxState(state, action, "reviewedByUser")
    case RECEIVE_REVIEW_NEEDED_TASKS:
      return updateReduxState(state, action, "reviewNeeded")
    case RECEIVE_REVIEW_METRICS:
      return updateReduxState(state, action, "metrics")
    case RECEIVE_REVIEW_CLUSTERS:
      return updateReduxState(state, action, "clusters")
    default:
      return state
  }
}

const updateReduxState = function(state={}, action, listName) {
  const mergedState = _cloneDeep(state)

  if (action.type === RECEIVE_REVIEW_METRICS) {
    mergedState[listName] = action.metrics
    return mergedState
  }

  if (action.type === RECEIVE_REVIEW_CLUSTERS) {
    const currentFetch = parseInt(_get(state, 'fetchId', 0), 10)
    if (parseInt(action.fetchId, 10) >= currentFetch) {
      mergedState.fetchId = action.fetchId
      mergedState[listName] = action.clusters
    }

    return mergedState
  }

  if (action.status === RequestStatus.success) {
    const updatedTasks = {}

    updatedTasks.tasks = _isArray(action.tasks) ? action.tasks : []
    updatedTasks.totalCount = action.totalCount
    updatedTasks.dataStale = false

    mergedState[listName] = updatedTasks
    return mergedState
  }
  else {
    return state
  }
}
